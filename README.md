# Professor Viva

> Your idea. His judgment.

An animated sarcastic professor who roasts your startup idea with academic fury and zero mercy.

## Features

- Keyword-based roast engine (AI wrappers, marketplaces, Uber-for-X, SaaS dashboards, creator economy)
- Animated professor with emoji state machine (neutral → suspicious → disappointed → furious/sarcastic)
- Timed dramatic reaction sequence before the verdict
- Metrics: Originality, Execution Difficulty, Founder Delusion, Survival Probability
- Copy Roast button
- Optional ElevenLabs text-to-speech (gracefully skipped if not configured)
- Mobile-friendly dark UI with cream card

## Local Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in your keys:

```
ELEVENLABS_API_KEY=your_key_here
VOICE_ID=your_voice_id_here
```

> TTS is optional. If the keys are missing, the app works fine — just silently skips audio.

**Finding a Voice ID:** Log into [elevenlabs.io](https://elevenlabs.io), go to Voices, pick any voice, and copy its ID from the URL or voice settings.

### 3. Run

```bash
node server.js
```

Or with auto-reload during development:

```bash
npm run dev
```

Then open: [http://localhost:3000](http://localhost:3000)

## API Endpoints

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `POST` | `/roast` | `{ idea: string }` | Returns roast text + metrics |
| `POST` | `/speak` | `{ text: string }` | Returns `audio/mpeg` stream via ElevenLabs |

## Roast Categories

| Keyword trigger | Professor's grievance |
|---|---|
| `ai`, `llm`, `gpt`, `chatbot` | AI wrapper complaints |
| `marketplace`, `platform` + buy/sell | Chicken-and-egg problem |
| `uber`, `airbnb for`, `tinder for` | Uber-for-X fatigue |
| `saas`, `dashboard`, `b2b` | Dashboard subscription despair |
| `creator`, `influencer`, `newsletter` | Creator economy cynicism |
| *(anything else)* | General founder delusion |

## Project Structure

```
professor-viva/
├── index.html       # Frontend (dark UI, professor animation, metrics)
├── server.js        # Express backend (roast engine + ElevenLabs TTS)
├── package.json
├── .env.example     # Environment variable template
└── README.md
```
