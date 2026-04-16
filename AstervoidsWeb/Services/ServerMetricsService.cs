using System.Collections.Concurrent;
using System.Diagnostics;

namespace AstervoidsWeb.Services;

/// <summary>
/// Thread-safe singleton service that collects backend server performance metrics.
/// Tracks system metrics (CPU, memory, GC, thread pool), connection counts,
/// hub invocation counts, and per-member TX/RX statistics.
/// </summary>
public sealed class ServerMetricsService : IDisposable
{
    private readonly Process _process;
    private readonly int _processorCount;

    // Connection tracking (Interlocked for thread safety)
    private long _connectedCount;
    private long _peakConnections;
    private long _totalHubInvocations;

    // Per-member metrics keyed by member ID
    private readonly ConcurrentDictionary<Guid, MemberMetricsEntry> _memberMetrics = new();

    // CPU sampling state
    private double _cpuUsagePercent;
    private DateTime _lastCpuSampleTime;
    private TimeSpan _lastCpuTime;
    private readonly object _cpuLock = new();
    private readonly Timer _cpuTimer;

    public ServerMetricsService()
    {
        _process = Process.GetCurrentProcess();
        _processorCount = Math.Max(1, Environment.ProcessorCount);

        _process.Refresh();
        _lastCpuSampleTime = DateTime.UtcNow;
        _lastCpuTime = _process.TotalProcessorTime;

        // Sample CPU usage every 2 seconds on a background timer
        _cpuTimer = new Timer(_ => SampleCpu(), null, TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(2));
    }

    // ── CPU sampling ───────────────────────────────────────────────────────────

    private void SampleCpu()
    {
        try
        {
            _process.Refresh();
            var now = DateTime.UtcNow;
            var cpuTime = _process.TotalProcessorTime;

            lock (_cpuLock)
            {
                var elapsedMs = (now - _lastCpuSampleTime).TotalMilliseconds;
                if (elapsedMs > 0)
                {
                    var cpuUsedMs = (cpuTime - _lastCpuTime).TotalMilliseconds;
                    _cpuUsagePercent = Math.Clamp(cpuUsedMs / (elapsedMs * _processorCount) * 100.0, 0.0, 100.0);
                }
                _lastCpuSampleTime = now;
                _lastCpuTime = cpuTime;
            }
        }
        catch
        {
            // Ignore errors during sampling — metrics are best-effort
        }
    }

    // ── Connection tracking ────────────────────────────────────────────────────

    /// <summary>Increments the current connection count and updates the peak.</summary>
    public void OnConnected()
    {
        var current = Interlocked.Increment(ref _connectedCount);

        // Lock-free peak update: retry until we win or a higher value is already stored
        long peak;
        do
        {
            peak = Interlocked.Read(ref _peakConnections);
            if (current <= peak) break;
        }
        while (Interlocked.CompareExchange(ref _peakConnections, current, peak) != peak);
    }

    /// <summary>Decrements the current connection count.</summary>
    public void OnDisconnected() => Interlocked.Decrement(ref _connectedCount);

    // ── Hub invocation tracking ────────────────────────────────────────────────

    /// <summary>
    /// Records a hub method invocation from the given member (TX from member to server).
    /// </summary>
    /// <param name="memberId">The member who invoked the hub method.</param>
    /// <param name="estimatedTxBytes">Optional estimated byte size of the request payload.</param>
    public void OnHubInvocation(Guid memberId, long estimatedTxBytes = 0)
    {
        Interlocked.Increment(ref _totalHubInvocations);
        var entry = _memberMetrics.GetOrAdd(memberId, _ => new MemberMetricsEntry());
        Interlocked.Increment(ref entry.TxCount);
        if (estimatedTxBytes > 0)
            Interlocked.Add(ref entry.TxBytes, estimatedTxBytes);
    }

    /// <summary>
    /// Records a broadcast message received by each of the specified members (RX to members).
    /// </summary>
    /// <param name="memberIds">Member IDs that received the broadcast.</param>
    /// <param name="estimatedRxBytesEach">Optional estimated byte size per recipient.</param>
    public void OnBroadcastToMembers(IEnumerable<Guid> memberIds, long estimatedRxBytesEach = 0)
    {
        foreach (var id in memberIds)
        {
            var entry = _memberMetrics.GetOrAdd(id, _ => new MemberMetricsEntry());
            Interlocked.Increment(ref entry.RxCount);
            if (estimatedRxBytesEach > 0)
                Interlocked.Add(ref entry.RxBytes, estimatedRxBytesEach);
        }
    }

    /// <summary>Records a GetSessionState (reconciliation) call from a member.</summary>
    public void OnReconciliation(Guid memberId)
    {
        var entry = _memberMetrics.GetOrAdd(memberId, _ => new MemberMetricsEntry());
        Interlocked.Increment(ref entry.Reconciliations);
    }

    /// <summary>Records a reconnection event (JoinSession with evictMemberId) for a member.</summary>
    public void OnReconnect(Guid memberId)
    {
        var entry = _memberMetrics.GetOrAdd(memberId, _ => new MemberMetricsEntry());
        Interlocked.Increment(ref entry.Reconnects);
    }

    /// <summary>Removes per-member metrics when a member departs.</summary>
    public void RemoveMember(Guid memberId) => _memberMetrics.TryRemove(memberId, out _);

    // ── Snapshot ───────────────────────────────────────────────────────────────

    /// <summary>
    /// Builds a point-in-time snapshot of all metrics for the API response.
    /// </summary>
    public ServerMetricsSnapshot GetSnapshot(ISessionService sessionService)
    {
        _process.Refresh();

        double cpuPercent;
        lock (_cpuLock) { cpuPercent = _cpuUsagePercent; }

        var gcInfo = GC.GetGCMemoryInfo();
        var totalMemoryBytes = gcInfo.TotalAvailableMemoryBytes;
        var workingSetBytes = _process.WorkingSet64;
        var memPercent = totalMemoryBytes > 0
            ? Math.Clamp((double)workingSetBytes / totalMemoryBytes * 100.0, 0.0, 100.0)
            : 0.0;

        ThreadPool.GetAvailableThreads(out var availWorkers, out var availIo);
        ThreadPool.GetMaxThreads(out var maxWorkers, out var maxIo);

        var uptimeSeconds = (DateTime.UtcNow - _process.StartTime.ToUniversalTime()).TotalSeconds;

        var system = new SystemMetricsSnapshot(
            UptimeSeconds: uptimeSeconds,
            CpuUsagePercent: Math.Round(cpuPercent, 1),
            MemoryUsagePercent: Math.Round(memPercent, 1),
            MemoryWorkingSetBytes: workingSetBytes,
            MemoryTotalBytes: totalMemoryBytes,
            GcGen0: GC.CollectionCount(0),
            GcGen1: GC.CollectionCount(1),
            GcGen2: GC.CollectionCount(2),
            ThreadPoolWorkerAvailable: availWorkers,
            ThreadPoolIoAvailable: availIo,
            ThreadPoolWorkerMax: maxWorkers,
            ThreadPoolIoMax: maxIo
        );

        var connections = new ConnectionMetricsSnapshot(
            CurrentConnections: Interlocked.Read(ref _connectedCount),
            PeakConnections: Interlocked.Read(ref _peakConnections),
            TotalHubInvocations: Interlocked.Read(ref _totalHubInvocations)
        );

        var sessions = sessionService.GetAllSessions()
            .Select(s =>
            {
                var memberSnapshots = s.Members.Values
                    .Select(m =>
                    {
                        _memberMetrics.TryGetValue(m.Id, out var e);
                        var ownedObjects = s.Objects.Values.Count(o => o.OwnerMemberId == m.Id);
                        return new MemberMetricsSnapshot(
                            MemberId: m.Id,
                            Role: m.Role.ToString(),
                            EventSequence: Interlocked.Read(ref m.EventSequence),
                            ObjectsOwned: ownedObjects,
                            TxCount: e != null ? Interlocked.Read(ref e.TxCount) : 0,
                            RxCount: e != null ? Interlocked.Read(ref e.RxCount) : 0,
                            TxBytes: e != null ? Interlocked.Read(ref e.TxBytes) : 0,
                            RxBytes: e != null ? Interlocked.Read(ref e.RxBytes) : 0,
                            Reconciliations: e != null ? Interlocked.Read(ref e.Reconciliations) : 0,
                            Reconnects: e != null ? Interlocked.Read(ref e.Reconnects) : 0
                        );
                    })
                    .ToList();

                return new SessionMetricsSnapshot(
                    SessionId: s.Id,
                    SessionName: s.Name,
                    MemberCount: s.Members.Count,
                    ObjectCount: s.Objects.Count,
                    CreatedAt: s.CreatedAt,
                    Members: memberSnapshots
                );
            })
            .ToList();

        return new ServerMetricsSnapshot(system, connections, sessions);
    }

    public void Dispose()
    {
        _cpuTimer.Dispose();
        _process.Dispose();
    }
}

/// <summary>Per-member mutable metrics counters (Interlocked-safe).</summary>
public class MemberMetricsEntry
{
    public long TxCount;
    public long TxBytes;
    public long RxCount;
    public long RxBytes;
    public long Reconciliations;
    public long Reconnects;
}

// ── Snapshot DTOs (immutable, JSON-serializable) ───────────────────────────────

public record SystemMetricsSnapshot(
    double UptimeSeconds,
    double CpuUsagePercent,
    double MemoryUsagePercent,
    long MemoryWorkingSetBytes,
    long MemoryTotalBytes,
    int GcGen0,
    int GcGen1,
    int GcGen2,
    int ThreadPoolWorkerAvailable,
    int ThreadPoolIoAvailable,
    int ThreadPoolWorkerMax,
    int ThreadPoolIoMax
);

public record ConnectionMetricsSnapshot(
    long CurrentConnections,
    long PeakConnections,
    long TotalHubInvocations
);

public record MemberMetricsSnapshot(
    Guid MemberId,
    string Role,
    long EventSequence,
    int ObjectsOwned,
    long TxCount,
    long RxCount,
    long TxBytes,
    long RxBytes,
    long Reconciliations,
    long Reconnects
);

public record SessionMetricsSnapshot(
    Guid SessionId,
    string SessionName,
    int MemberCount,
    int ObjectCount,
    DateTime CreatedAt,
    List<MemberMetricsSnapshot> Members
);

public record ServerMetricsSnapshot(
    SystemMetricsSnapshot System,
    ConnectionMetricsSnapshot Connections,
    List<SessionMetricsSnapshot> Sessions
);
