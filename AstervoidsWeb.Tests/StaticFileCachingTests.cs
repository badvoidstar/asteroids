using System.Net;
using FluentAssertions;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;

namespace AstervoidsWeb.Tests;

/// <summary>
/// Integration tests for the content-hash ETag + Cache-Control middleware in Program.cs.
/// Boots a real TestServer against the AstervoidsWeb project's wwwroot files.
/// </summary>
public class StaticFileCachingTests : IClassFixture<StaticFileCachingTests.Factory>
{
    /// <summary>
    /// Custom factory that sets the content root to the AstervoidsWeb project directory
    /// so the ETag table at startup can find and hash the actual wwwroot files.
    /// </summary>
    public sealed class Factory : WebApplicationFactory<Program>
    {
        protected override void ConfigureWebHost(IWebHostBuilder builder) =>
            builder.UseContentRoot(FindContentRoot());

        private static string FindContentRoot()
        {
            // Walk up from the test output directory until we find a sibling "AstervoidsWeb"
            // directory that contains wwwroot (i.e. the web project directory).
            var dir = new DirectoryInfo(AppContext.BaseDirectory);
            while (dir != null)
            {
                var candidate = Path.Combine(dir.FullName, "AstervoidsWeb");
                if (Directory.Exists(Path.Combine(candidate, "wwwroot")))
                    return candidate;
                dir = dir.Parent;
            }
            throw new DirectoryNotFoundException(
                "Could not find AstervoidsWeb project directory with wwwroot. " +
                $"Searched upward from: {AppContext.BaseDirectory}");
        }
    }

    private readonly Factory _factory;

    public StaticFileCachingTests(Factory factory) => _factory = factory;

    // -------------------------------------------------------------------------
    // Test 1: first GET returns 200 with ETag and Cache-Control: no-cache
    // -------------------------------------------------------------------------

    [Theory]
    [InlineData("/index.html")]
    [InlineData("/manifest.json")]
    public async Task Get_StaticFile_ReturnsOk_WithETagAndNoCacheHeader(string path)
    {
        var client = _factory.CreateClient();
        var response = await client.GetAsync(path);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        response.Headers.ETag.Should().NotBeNull();
        response.Headers.ETag!.Tag.Should().NotBeNullOrEmpty();
        response.Headers.CacheControl.Should().NotBeNull();
        response.Headers.CacheControl!.NoCache.Should().BeTrue();
    }

    // -------------------------------------------------------------------------
    // Test 2: GET with matching If-None-Match returns 304 with no body
    // -------------------------------------------------------------------------

    [Theory]
    [InlineData("/index.html")]
    [InlineData("/manifest.json")]
    public async Task Get_WithMatchingIfNoneMatch_Returns304WithNoBody(string path)
    {
        var client = _factory.CreateClient();

        // First request — capture the ETag
        var firstResponse = await client.GetAsync(path);
        firstResponse.StatusCode.Should().Be(HttpStatusCode.OK);
        var etag = firstResponse.Headers.ETag!.Tag;

        // Conditional request with the matching ETag
        var conditionalRequest = new HttpRequestMessage(HttpMethod.Get, path);
        conditionalRequest.Headers.IfNoneMatch.ParseAdd(etag);
        var conditionalResponse = await client.SendAsync(conditionalRequest);

        conditionalResponse.StatusCode.Should().Be(HttpStatusCode.NotModified);
        var body = await conditionalResponse.Content.ReadAsStringAsync();
        body.Should().BeEmpty();
    }

    // -------------------------------------------------------------------------
    // Test 3: GET with wrong If-None-Match returns 200 with body and correct ETag
    // -------------------------------------------------------------------------

    [Theory]
    [InlineData("/index.html")]
    [InlineData("/manifest.json")]
    public async Task Get_WithNonMatchingIfNoneMatch_Returns200WithBody(string path)
    {
        var client = _factory.CreateClient();

        // First request — capture the correct ETag
        var firstResponse = await client.GetAsync(path);
        var correctEtag = firstResponse.Headers.ETag!.Tag;

        // Conditional request with a wrong ETag
        var conditionalRequest = new HttpRequestMessage(HttpMethod.Get, path);
        conditionalRequest.Headers.IfNoneMatch.ParseAdd("\"wrongetag1234567890abcdef\"");
        var conditionalResponse = await client.SendAsync(conditionalRequest);

        conditionalResponse.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await conditionalResponse.Content.ReadAsStringAsync();
        body.Should().NotBeEmpty();
        conditionalResponse.Headers.ETag!.Tag.Should().Be(correctEtag);
    }

    // -------------------------------------------------------------------------
    // Test 4: ETag for "/" equals ETag for "/index.html" (UseDefaultFiles rewrite)
    // -------------------------------------------------------------------------

    [Fact]
    public async Task Get_Root_HasSameETagAsIndexHtml()
    {
        var client = _factory.CreateClient();

        // "/" is rewritten to "/index.html" by UseDefaultFiles before our middleware runs
        var rootResponse = await client.GetAsync("/");
        var indexResponse = await client.GetAsync("/index.html");

        rootResponse.StatusCode.Should().Be(HttpStatusCode.OK);
        indexResponse.StatusCode.Should().Be(HttpStatusCode.OK);
        rootResponse.Headers.ETag.Should().NotBeNull();
        indexResponse.Headers.ETag.Should().NotBeNull();
        rootResponse.Headers.ETag!.Tag.Should().Be(indexResponse.Headers.ETag!.Tag);
    }

    // -------------------------------------------------------------------------
    // Test 5: ETags for two different files are different
    // -------------------------------------------------------------------------

    [Fact]
    public async Task ETagsForDifferentFiles_AreDifferent()
    {
        var client = _factory.CreateClient();

        var indexResponse = await client.GetAsync("/index.html");
        var manifestResponse = await client.GetAsync("/manifest.json");

        indexResponse.Headers.ETag.Should().NotBeNull();
        manifestResponse.Headers.ETag.Should().NotBeNull();
        indexResponse.Headers.ETag!.Tag.Should().NotBe(manifestResponse.Headers.ETag!.Tag);
    }
}
