namespace AstervoidsWeb.Services;

/// <summary>
/// Default name generator that assigns fruit names to sessions.
/// </summary>
public class FruitNameGenerator : ISessionNameGenerator
{
    private static readonly string[] FruitNames =
    [
        "Apple", "Banana", "Cherry", "Date", "Elderberry",
        "Fig", "Grape", "Honeydew", "Kiwi", "Lemon",
        "Mango", "Nectarine", "Orange", "Papaya", "Quince",
        "Raspberry", "Strawberry", "Tangerine", "Watermelon", "Blueberry",
        "Coconut", "Dragonfruit", "Guava", "Jackfruit", "Lychee",
        "Mulberry", "Olive", "Peach", "Pear", "Plum",
        "Pomegranate", "Apricot", "Avocado", "Blackberry", "Cantaloupe",
        "Clementine", "Cranberry", "Currant", "Durian", "Grapefruit",
        "Lime", "Mandarin", "Passion", "Persimmon", "Pineapple",
        "Plantain", "Starfruit", "Tamarind", "Yuzu", "Kumquat"
    ];

    private readonly Random _random = new();

    /// <inheritdoc />
    public string GenerateUniqueName(IReadOnlySet<string> usedNames)
    {
        var availableNames = FruitNames.Where(n => !usedNames.Contains(n)).ToList();

        if (availableNames.Count == 0)
        {
            // All fruit names used, append a number
            var counter = 2;
            while (true)
            {
                var candidateName = $"{FruitNames[_random.Next(FruitNames.Length)]}{counter}";
                if (!usedNames.Contains(candidateName))
                    return candidateName;
                counter++;
            }
        }

        return availableNames[_random.Next(availableNames.Count)];
    }
}
