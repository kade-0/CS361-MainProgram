using MultiplayerService.Client;

// usage: <server endpoint> <api key>
if (args.Length < 2)
{
    Console.WriteLine("Usage: <server endpoint> <api key>");
    Console.WriteLine("Example: ws://localhost:3000/play/g_8f3a21 mps_abc123");
    return 1;
}

await using var client = new MultiplayerClient(args[0], args[1]);
var stopped = new TaskCompletionSource();

// lifecycle events
client.Connected += e =>
{
    if (e.Resumed) Log($"Session resumed as client {e.ClientId}, {e.MissedMessages} missed messages");
    else Log($"API key accepted. Client id {e.ClientId}, {e.Players} of {e.MaxPlayers} players connected");
    _ = client.PingAsync();
};
client.Reconnecting += e => Log($"Reconnecting in {e.Delay.TotalSeconds:F0}s (attempt {e.Attempt} of {e.MaxAttempts})");
client.Disconnected += e =>
{
    Log($"Disconnected ({e.CloseCode} {e.Reason})");
    if (!e.WillReconnect) stopped.TrySetResult();
};
client.LatencyMeasured += t => Log($"Connected ({t.TotalMilliseconds:F0} ms round trip)");
client.ServerError += m => Log($"Server error: {m}");

// other players
client.PlayerJoined += e => Log($"Client {e.ClientId} joined ({e.Players} connected)");
client.PlayerLeft += e => Log($"Client {e.ClientId} left ({e.Players} connected)");
client.PlayerConnectionLost += e => Log($"Client {e.ClientId} lost connection, holding their slot");
client.PlayerReconnected += e => Log($"Client {e.ClientId} reconnected");

// typed callback for our own message type
client.On<ChatMessage>("chat", (from, chat) => Log($"From {from}: {chat.Text}"));

Console.CancelKeyPress += (_, e) => { e.Cancel = true; stopped.TrySetResult(); };

Log($"Opening connection to {args[0]}");
try
{
    await client.ConnectAsync();
}
catch (MultiplayerException ex)
{
    Log($"Could not connect: {ex.Message} ({ex.CloseCode})");
    return 1;
}

Log("Type a message and press Enter to send it. Type /drop to drop the connection. Press Ctrl+C to exit.");
while (!stopped.Task.IsCompleted)
{
    var readTask = Task.Run(Console.ReadLine);
    if (await Task.WhenAny(readTask, stopped.Task) == stopped.Task) break;
    var line = readTask.Result;
    if (string.IsNullOrEmpty(line)) break;
    if (line == "/drop")
    {
        Log("Dropping connection");
        client.DropConnection();
        continue;
    }
    try { await client.SendAsync(new ChatMessage("chat", line)); }
    catch (MultiplayerException ex) { Log($"Not sent: {ex.Message}"); }
}

await client.DisconnectAsync();
return 0;

static void Log(string text)
{
    Console.WriteLine($"{DateTime.Now:HH:mm:ss} {text}");
}

record ChatMessage(string Type, string Text);
