# Agora Health Voice

A local voice recipe for asking about sleep, daily heart rate, steps and distance, and recent activities. It uses Agora Conversational AI, ARES, Agora-managed GPT-4o-mini, and Murf. The default provider reads fictional fixtures and requires no health account.

## Run locally on macOS

Requires Node.js 24 or later and a browser with microphone permission.

```sh
npm ci
cp .env.example .env
npm start
```

Open [http://localhost:3000](http://localhost:3000). With the voice settings blank, the app shows its synthetic-data indicator and setup state. Use `npm run check` and `npm test` to validate the project offline. Tests use mock Agora responses.

## Enable voice and callbacks

1. Use an Agora project with RTC token authentication and **Conversational AI Main v2** access. Fill in the project App ID and App Certificate, Agora REST Customer ID and Customer Secret, and your Murf API key in `.env`. Managed GPT-4o-mini uses Agora credentials.
2. In another terminal, manually start a temporary HTTPS tunnel to the **callback port**. With [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/), the command is:

   ```sh
   cloudflared tunnel --url http://127.0.0.1:3001
   ```

3. Set `TOOL_CALLBACK_ORIGIN` to the printed HTTPS origin, without a path. Restart `npm start` and reload the local page. A fresh tunnel normally gets a new URL.
4. Select **Start**, allow microphone access, and speak. The browser sends microphone audio to Agora. A live voice session can incur Agora or Murf charges even with synthetic fixtures.

One Node process binds two loopback listeners. Port **3000** serves the browser and local session controls. Tunnel only port **3001**, which serves the four POST callbacks and requires a random per-session bearer. Requests for the browser or session controls on the callback port receive `404`. A tool POST without the bearer receives `401`. Keep credentials in the ignored `.env` file. The browser receives a short-lived RTC token, and the server does not log tool data or secrets.

## Try it

The fixture date is **2025-02-14**. Ask these questions after the agent connects.

| Ask | Fixture answer |
|---|---|
| How did I sleep last night? | 7 hours 24 minutes, recorded on February 14 |
| What was my resting heart rate yesterday? | 56 bpm on February 13 |
| How many steps did I take yesterday, and how far did I go? | 8,240 steps and 5.91 km on February 13 |
| What were my last three activities? | Run, strength training, and walk, newest first |
| What were my heart-rate readings on February 12, 2025? | 59 bpm resting. Minimum and maximum are missing. |

Select **Stop** to close the microphone and stop the remote agent. The local server ends the session after three minutes. Agora also exits after the browser leaves the channel and the 30-second idle timeout elapses. If the browser blocks playback, select **Enable audio**. After the demo, stop the tunnel and the Node server with Control-C in their respective terminals.

See [the provider guide](docs/providers.md) for the single custom adapter extension point. See [Agora’s Main v2 start reference](https://docs.agora.io/en/api-reference/api-ref/conversational-ai/join) for the session API.

## Temporary Basic Voice test

Run `VOICE_MODE=basic npm start` to use the existing Start/Stop page for a simple conversation.
This mode uses the same RTC, ARES, GPT-4o-mini, and Murf settings, with no custom
tools or callback headers in the agent request. It uses the prompt “You are a friendly
voice assistant. Answer briefly.” The default `VOICE_MODE=health` retains the health assistant.
