using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace MultiplayerService.Client;

public sealed class MultiplayerClient : IAsyncDisposable
{
    static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    readonly string endpoint;
    readonly string apiKey;
    readonly MultiplayerClientOptions options;
    readonly Stopwatch clock = Stopwatch.StartNew();
    readonly SemaphoreSlim sendLock = new(1, 1);
    readonly ConcurrentDictionary<string, List<Action<string, JsonElement>>> handlers = new();
    ClientWebSocket? socket;
    CancellationTokenSource? lifetime;
    Task? runTask;
    string? resumeToken;
    bool closing;

    // connection lifecycle events
    public event Action<ConnectedEventArgs>? Connected;
    public event Action<ReconnectingEventArgs>? Reconnecting;
    public event Action<DisconnectedEventArgs>? Disconnected;
    public event Action<ConnectionState>? StateChanged;

    // other players in the same game session
    public event Action<PlayerEventArgs>? PlayerJoined;
    public event Action<PlayerEventArgs>? PlayerLeft;
    public event Action<PlayerEventArgs>? PlayerConnectionLost;
    public event Action<PlayerEventArgs>? PlayerReconnected;

    // every relayed message, before type handlers run (sender id, message)
    public event Action<string, JsonElement>? MessageReceived;

    public event Action<TimeSpan>? LatencyMeasured;
    public event Action<string>? ServerError;

    public ConnectionState State { get; private set; } = ConnectionState.Disconnected;
    public string? ClientId { get; private set; }
    public int Players { get; private set; }
    public int MaxPlayers { get; private set; }

    public MultiplayerClient(string endpoint, string apiKey, MultiplayerClientOptions? options = null)
    {
        this.endpoint = endpoint;
        this.apiKey = apiKey;
        this.options = options ?? new MultiplayerClientOptions();
    }

    // registers a callback for messages with a matching "type" field
    // returns an IDisposable that removes the callback
    public IDisposable On<T>(string type, Action<string, T> callback)
    {
        Action<string, JsonElement> wrapper = (from, element) => callback(from, element.Deserialize<T>(JsonOptions)!);
        var list = handlers.GetOrAdd(type, _ => new List<Action<string, JsonElement>>());
        lock (list) list.Add(wrapper);
        return new Subscription(() => { lock (list) list.Remove(wrapper); });
    }

    // connects and waits for the server to accept the api key
    // throws MultiplayerException if the server rejects the connection
    public async Task ConnectAsync(CancellationToken token = default)
    {
        if (runTask != null) throw new InvalidOperationException("Already connected.");
        closing = false;
        resumeToken = null;
        lifetime = new CancellationTokenSource();
        SetState(ConnectionState.Connecting);
        try
        {
            await OpenAsync(token);
        }
        catch
        {
            SetState(ConnectionState.Disconnected);
            throw;
        }
        runTask = Task.Run(() => RunAsync(lifetime.Token));
    }

    // sends a message to every other player in the session
    // give it a "type" property so receivers can use On<T>; the type "ping" is reserved
    public async Task SendAsync<T>(T message, CancellationToken token = default)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(message, JsonOptions);
        await SendRawAsync(bytes, token);
    }

    // measures the round trip time, reported through LatencyMeasured
    public Task PingAsync(CancellationToken token = default)
    {
        return SendAsync(new { type = "ping", t = clock.Elapsed.TotalMilliseconds }, token);
    }

    // kills the socket without a close handshake, for testing reconnects
    public void DropConnection()
    {
        socket?.Abort();
    }

    // leaves the session cleanly so the server frees the slot right away
    public async Task DisconnectAsync()
    {
        closing = true;
        if (socket?.State == WebSocketState.Open)
        {
            try { await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "Client closing", CancellationToken.None); }
            catch (WebSocketException) { }
        }
        lifetime?.Cancel();
        if (runTask != null) await runTask;
        runTask = null;
    }

    public async ValueTask DisposeAsync()
    {
        await DisconnectAsync();
        socket?.Dispose();
        lifetime?.Dispose();
        sendLock.Dispose();
    }

    // opens a socket and reads the welcome, resuming the old session if we have a token
    async Task OpenAsync(CancellationToken token)
    {
        socket?.Dispose();
        socket = new ClientWebSocket();
        socket.Options.KeepAliveInterval = options.KeepAliveInterval;
        socket.Options.KeepAliveTimeout = options.KeepAliveTimeout;
        try
        {
            await socket.ConnectAsync(BuildUri(), token);
        }
        catch (WebSocketException ex)
        {
            throw new MultiplayerException($"Could not reach the server: {ex.Message}", null, ex);
        }
        var first = await ReadMessageAsync(token);
        if (first is JsonElement msg && msg.GetProperty("type").GetString() == "welcome")
        {
            HandleWelcome(msg);
            return;
        }
        var reason = first?.TryGetProperty("message", out var m) == true ? m.GetString() : "Connection was rejected.";
        if (socket.State == WebSocketState.Open) await ReadMessageAsync(token);
        throw new MultiplayerException(reason ?? "Connection was rejected.", (int?)socket.CloseStatus);
    }

    Uri BuildUri()
    {
        var url = $"{endpoint}?key={Uri.EscapeDataString(apiKey)}";
        if (resumeToken != null) url += $"&resume={Uri.EscapeDataString(resumeToken)}";
        return new Uri(url);
    }

    // receives until the connection ends, then reconnects or stops
    async Task RunAsync(CancellationToken token)
    {
        while (true)
        {
            await ReceiveLoopAsync(token);
            var code = (int?)socket?.CloseStatus;
            var reason = socket?.CloseStatusDescription;
            if (closing || token.IsCancellationRequested || CloseCodes.IsFatal(code) || !options.AutoReconnect)
            {
                Stop(code, reason ?? (closing ? "Client closing" : "Connection lost"));
                return;
            }
            Disconnected?.Invoke(new DisconnectedEventArgs(code, reason ?? "Connection lost", true));
            var failure = await ReconnectAsync(token);
            if (failure != null)
            {
                Stop(failure.CloseCode, failure.Message);
                return;
            }
        }
    }

    // tries to reconnect with backoff, returns the error if it gave up
    async Task<MultiplayerException?> ReconnectAsync(CancellationToken token)
    {
        SetState(ConnectionState.Reconnecting);
        MultiplayerException? last = null;
        for (var attempt = 1; attempt <= options.MaxReconnectAttempts; attempt++)
        {
            var delay = TimeSpan.FromSeconds(Math.Min(options.MaxReconnectDelay.TotalSeconds, Math.Pow(2, attempt - 1)));
            Reconnecting?.Invoke(new ReconnectingEventArgs(attempt, options.MaxReconnectAttempts, delay));
            try
            {
                await Task.Delay(delay, token);
                await OpenAsync(token);
                return null;
            }
            catch (OperationCanceledException)
            {
                return new MultiplayerException("Client closing", CloseCodes.Normal);
            }
            catch (MultiplayerException ex)
            {
                last = ex;
                if (CloseCodes.IsFatal(ex.CloseCode)) return ex;
            }
        }
        return new MultiplayerException($"Gave up after {options.MaxReconnectAttempts} attempts. {last?.Message}", last?.CloseCode);
    }

    void Stop(int? code, string? reason)
    {
        SetState(ConnectionState.Disconnected);
        Disconnected?.Invoke(new DisconnectedEventArgs(code, reason, false));
    }

    async Task ReceiveLoopAsync(CancellationToken token)
    {
        try
        {
            while (socket!.State == WebSocketState.Open)
            {
                var msg = await ReadMessageAsync(token);
                if (msg is null) break;
                Dispatch(msg.Value);
            }
        }
        catch (OperationCanceledException) { }
        catch (WebSocketException) { }
    }

    // reads one full message, returns null when the socket closes
    async Task<JsonElement?> ReadMessageAsync(CancellationToken token)
    {
        var buffer = new byte[16 * 1024];
        using var stream = new MemoryStream();
        WebSocketReceiveResult result;
        do
        {
            result = await socket!.ReceiveAsync(buffer, token);
            if (result.MessageType == WebSocketMessageType.Close) return null;
            stream.Write(buffer, 0, result.Count);
        } while (!result.EndOfMessage);
        using var doc = JsonDocument.Parse(Encoding.UTF8.GetString(stream.ToArray()));
        return doc.RootElement.Clone();
    }

    void HandleWelcome(JsonElement msg)
    {
        resumeToken = msg.GetProperty("resumeToken").GetString();
        ClientId = msg.GetProperty("clientId").GetString();
        Players = msg.GetProperty("players").GetInt32();
        MaxPlayers = msg.GetProperty("maxPlayers").GetInt32();
        var resumed = msg.GetProperty("resumed").GetBoolean();
        var missed = resumed ? msg.GetProperty("missed").EnumerateArray().ToList() : new List<JsonElement>();
        SetState(ConnectionState.Connected);
        Connected?.Invoke(new ConnectedEventArgs(ClientId!, Players, MaxPlayers, resumed, missed.Count));
        foreach (var m in missed) Dispatch(m);
    }

    // routes a server message to the matching event or callback
    void Dispatch(JsonElement msg)
    {
        switch (msg.GetProperty("type").GetString())
        {
            case "pong":
                Players = msg.GetProperty("players").GetInt32();
                LatencyMeasured?.Invoke(TimeSpan.FromMilliseconds(clock.Elapsed.TotalMilliseconds - msg.GetProperty("t").GetDouble()));
                break;
            case "join":
                PlayerJoined?.Invoke(PlayerArgs(msg));
                break;
            case "leave":
                PlayerLeft?.Invoke(PlayerArgs(msg));
                break;
            case "disconnected":
                PlayerConnectionLost?.Invoke(PlayerArgs(msg));
                break;
            case "reconnected":
                PlayerReconnected?.Invoke(PlayerArgs(msg));
                break;
            case "message":
                DispatchMessage(msg.GetProperty("from").GetString()!, msg.GetProperty("data"));
                break;
            case "error":
                ServerError?.Invoke(msg.GetProperty("message").GetString() ?? "Unknown error");
                break;
        }
    }

    void DispatchMessage(string from, JsonElement data)
    {
        MessageReceived?.Invoke(from, data);
        if (!data.TryGetProperty("type", out var typeProp) || typeProp.GetString() is not string type) return;
        if (!handlers.TryGetValue(type, out var list)) return;
        Action<string, JsonElement>[] snapshot;
        lock (list) snapshot = list.ToArray();
        foreach (var handler in snapshot) handler(from, data);
    }

    PlayerEventArgs PlayerArgs(JsonElement msg)
    {
        Players = msg.GetProperty("players").GetInt32();
        return new PlayerEventArgs(msg.GetProperty("clientId").GetString()!, Players);
    }

    async Task SendRawAsync(byte[] bytes, CancellationToken token)
    {
        if (socket?.State != WebSocketState.Open) throw new MultiplayerException("Not connected.");
        await sendLock.WaitAsync(token);
        try { await socket.SendAsync(bytes, WebSocketMessageType.Text, true, token); }
        finally { sendLock.Release(); }
    }

    void SetState(ConnectionState state)
    {
        if (State == state) return;
        State = state;
        StateChanged?.Invoke(state);
    }

    sealed class Subscription(Action dispose) : IDisposable
    {
        public void Dispose() => dispose();
    }
}
