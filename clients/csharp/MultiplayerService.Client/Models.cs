namespace MultiplayerService.Client;

// settings for connecting and reconnecting
public sealed class MultiplayerClientOptions
{
    public bool AutoReconnect { get; set; } = true;
    public int MaxReconnectAttempts { get; set; } = 5;
    public TimeSpan MaxReconnectDelay { get; set; } = TimeSpan.FromSeconds(8);

    // how often the client pings the server, and how long it waits for an answer before treating the connection as lost
    public TimeSpan KeepAliveInterval { get; set; } = TimeSpan.FromSeconds(10);
    public TimeSpan KeepAliveTimeout { get; set; } = TimeSpan.FromSeconds(20);
}

// close codes the server sends when it ends a connection on purpose
public static class CloseCodes
{
    public const int Normal = 1000;
    public const int InvalidApiKey = 4001;
    public const int SessionFull = 4003;
    public const int GameNotFound = 4004;
    public const int ApiKeyRegenerated = 4005;
    public const int TestSessionEnded = 4008;
    
    public static bool IsFatal(int? code)
    {
        return code is InvalidApiKey or SessionFull or GameNotFound or ApiKeyRegenerated or TestSessionEnded;
    }
}

public enum ConnectionState
{
    Disconnected,
    Connecting,
    Connected,
    Reconnecting
}

// sent with Connected, both for a fresh join and a resumed session
public sealed record ConnectedEventArgs(string ClientId, int Players, int MaxPlayers, bool Resumed, int MissedMessages);

// sent for join, leave, lost connection and reconnect of other players
public sealed record PlayerEventArgs(string ClientId, int Players);

// sent before each reconnect attempt
public sealed record ReconnectingEventArgs(int Attempt, int MaxAttempts, TimeSpan Delay);

// sent once when the client stops for good
public sealed record DisconnectedEventArgs(int? CloseCode, string? Reason, bool WillReconnect);

public sealed class MultiplayerException : Exception
{
    public int? CloseCode { get; }

    public MultiplayerException(string message, int? closeCode = null, Exception? inner = null) : base(message, inner)
    {
        CloseCode = closeCode;
    }
}
