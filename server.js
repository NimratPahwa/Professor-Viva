require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ─── Roast database ────────────────────────────────────────────────────────────

const roasts = {
  ai: [
    {
      roast: "Oh wonderful. ANOTHER AI wrapper. You took OpenAI's API, put a thin layer of CSS on top, and now you expect venture capitalists to give you seventeen million dollars. Brilliant. Absolutely brilliant. My peon in 1998 had more original ideas, and he was asleep.",
      mood: "Furious",
      originality: 1,
      execution: 3,
      delusion: 9,
      survival: 4,
      emoji: "😤"
    },
    {
      roast: "Let me understand. You wrapped GPT-4 in a Next.js app, gave it a name that ends in '.ai', and you think this is a startup. This is not a startup. This is a weekend project that escaped. The moment OpenAI adds one more feature, your entire company is deprecated like Internet Explorer.",
      mood: "Deeply Disappointed",
      originality: 2,
      execution: 4,
      delusion: 8,
      survival: 7,
      emoji: "😑"
    },
    {
      roast: "AI-powered, you say. Everything is AI-powered now! My toaster has AI! My neighbour's dog has AI! What specific problem does YOUR AI solve that cannot be solved by asking ChatGPT directly? ... No? Nothing? Thought so. Next.",
      mood: "Exasperated",
      originality: 2,
      execution: 5,
      delusion: 8,
      survival: 6,
      emoji: "👏"
    }
  ],
  marketplace: [
    {
      roast: "Ah yes, a marketplace. The classic chicken-and-egg problem, now served fresh with YOUR special ignorance sauce. Tell me — who comes first? The buyers with no sellers, or the sellers with no buyers? You need BOTH and you have NEITHER. This is not a business plan, this is an existential crisis.",
      mood: "Philosophically Furious",
      originality: 3,
      execution: 9,
      delusion: 8,
      survival: 9,
      emoji: "😤"
    },
    {
      roast: "A two-sided marketplace. Very good. Very brave. Amazon tried this and they had to BUILD THEIR OWN INVENTORY for years. You have seventeen thousand rupees and a LinkedIn profile. Best of luck with your liquidity problem, which will begin on day one and end on the day you shut down.",
      mood: "Sarcastically Supportive",
      originality: 3,
      execution: 9,
      delusion: 7,
      survival: 12,
      emoji: "👏"
    }
  ],
  uber: [
    {
      roast: "Uber for X. The laziest category of startup known to humankind. Uber for dog grooming. Uber for groceries. Uber for prayers. Listen — Uber ITSELF is barely profitable after fifteen years and twelve billion dollars! You want to do this for... laundry? With what funding? Your optimism?",
      mood: "Historically Offended",
      originality: 1,
      execution: 8,
      delusion: 9,
      survival: 5,
      emoji: "😤"
    },
    {
      roast: "Oh very nice. Uber for X. You know what happened to all the Uber-for-X companies? They either got acquired for nothing, or they died quietly while their founders blamed 'market timing'. The market timing was fine. The idea was the problem.",
      mood: "Clinically Disappointed",
      originality: 1,
      execution: 7,
      delusion: 7,
      survival: 8,
      emoji: "😑"
    }
  ],
  saas: [
    {
      roast: "Another SaaS dashboard. With another subscription. For another workflow that could be handled by a Google Sheet. Tell me — what does your dashboard SHOW that Microsoft Excel, built in 1987, cannot already do? Take your time. I have tenure. I am not going anywhere.",
      mood: "Patiently Furious",
      originality: 3,
      execution: 5,
      delusion: 7,
      survival: 15,
      emoji: "🤨"
    },
    {
      roast: "SaaS, forty-nine dollars per month, unlimited users, cancel anytime. I have seen this landing page. I have seen it four hundred times. What is your CAC? What is your LTV? What is your churn? You don't know, do you. You don't know because you haven't launched. You haven't launched because deep down, you know.",
      mood: "Prophetically Grim",
      originality: 4,
      execution: 6,
      delusion: 7,
      survival: 11,
      emoji: "😑"
    }
  ],
  creator: [
    {
      roast: "A platform for creators. Wonderful. You want to compete with YouTube, Substack, Patreon, TikTok, Instagram, Gumroad, Beehiiv, and seventeen other platforms — all of whom have a head start of approximately ten years and two billion dollars. What is your differentiation? 'Better community'. That is not a moat. That is a puddle.",
      mood: "Exhausted",
      originality: 2,
      execution: 8,
      delusion: 8,
      survival: 6,
      emoji: "😑"
    },
    {
      roast: "Creator economy! Everyone is talking about creator economy! You know what creators want? MONEY. Not another platform with better analytics and a 'supportive community'. They want money. You are going to give them community. They will leave you for Patreon in three months.",
      mood: "Prophetically Correct",
      originality: 3,
      execution: 7,
      delusion: 7,
      survival: 8,
      emoji: "😤"
    }
  ],
  random: [
    {
      roast: "I have been a professor for twenty-three years. I have reviewed four hundred and twelve business ideas. Yours is, without question, among the four hundred and twelve. The market you are targeting does not know it needs your solution because it does not. The problem you are solving is a problem you invented to justify the solution you already built.",
      mood: "Professionally Defeated",
      originality: 5,
      execution: 6,
      delusion: 7,
      survival: 18,
      emoji: "😑"
    },
    {
      roast: "Very bold idea. Very bold. Tell me — have you done any customer discovery? Have you spoken to even ONE potential user? No? You have spoken to your friends and family who said 'wow what a great idea'? Those people LOVE you. They are LYING to you. That is what love does. The market does not love you.",
      mood: "Tenderly Brutal",
      originality: 5,
      execution: 6,
      delusion: 8,
      survival: 20,
      emoji: "🤨"
    },
    {
      roast: "Congratulations. You have identified a problem, imagined a solution, and skipped every step in between. There is no go-to-market. There is no revenue model. There is no moat. There is only vibes and a Figma prototype your cousin made. This is not a startup. This is a mood board.",
      mood: "Architecturally Appalled",
      originality: 4,
      execution: 7,
      delusion: 8,
      survival: 14,
      emoji: "👏"
    },
    {
      roast: "You know what I find remarkable? Your confidence. To walk in here, state this idea with a straight face, and expect validation — that alone shows founder potential. Unfortunately, founder potential and a viable business are two completely separate things, and you currently possess only one of them.",
      mood: "Backhanded Encouragement",
      originality: 5,
      execution: 5,
      delusion: 9,
      survival: 22,
      emoji: "👏"
    },
    {
      roast: "First of all — what problem are you solving? Second of all — for whom? Third of all — why you? Fourth of all — why now? You have answered none of these questions. You have, however, given me a very detailed description of the app's UI. I am not a designer. I am your target customer. And I am walking away.",
      mood: "Methodically Unimpressed",
      originality: 4,
      execution: 6,
      delusion: 7,
      survival: 16,
      emoji: "😑"
    },
    {
      roast: "I see you have done a competitor analysis. You have found that there are no direct competitors. Do you know what no direct competitors means? It means either you have found a genuine gap in the market — which happens once per decade — or, far more likely, it means others have tried this and quietly given up. Which do you think is more probable?",
      mood: "Statistically Grim",
      originality: 6,
      execution: 7,
      delusion: 6,
      survival: 19,
      emoji: "🤨"
    }
  ]
};

function getRoast(idea) {
  const lower = idea.toLowerCase();
  let pool;

  if (lower.includes('ai') || lower.includes('artificial intelligence') || lower.includes('machine learning') || lower.includes('llm') || lower.includes('gpt') || lower.includes('chatbot')) {
    pool = roasts.ai;
  } else if (lower.includes('marketplace') || lower.includes('platform') && (lower.includes('buy') || lower.includes('sell') || lower.includes('connect'))) {
    pool = roasts.marketplace;
  } else if (lower.includes('uber') || lower.includes('uber for') || lower.includes('airbnb for') || lower.includes('tinder for')) {
    pool = roasts.uber;
  } else if (lower.includes('saas') || lower.includes('dashboard') || lower.includes('subscription') || lower.includes('b2b')) {
    pool = roasts.saas;
  } else if (lower.includes('creator') || lower.includes('influencer') || lower.includes('content creator') || lower.includes('newsletter')) {
    pool = roasts.creator;
  } else {
    pool = roasts.random;
  }

  return pool[Math.floor(Math.random() * pool.length)];
}

// ─── Routes ────────────────────────────────────────────────────────────────────

app.post('/roast', (req, res) => {
  const { idea } = req.body;

  if (!idea || typeof idea !== 'string' || idea.trim().length < 3) {
    return res.status(400).json({ error: 'Please provide a startup idea.' });
  }

  if (idea.trim().length > 2000) {
    return res.status(400).json({ error: 'Idea too long. Professors have limited patience.' });
  }

  const result = getRoast(idea.trim());
  res.json(result);
});

app.post('/speak', async (req, res) => {
  const { text } = req.body;

  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'No text provided.' });
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.VOICE_ID;

  if (!apiKey || !voiceId) {
    return res.status(503).json({ error: 'TTS not configured.' });
  }

  try {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg'
      },
      body: JSON.stringify({
        text: text.slice(0, 500),
        model_id: 'eleven_monolingual_v1',
        voice_settings: {
          stability: 0.4,
          similarity_boost: 0.75,
          style: 0.6,
          use_speaker_boost: true
        }
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('ElevenLabs error:', err);
      return res.status(502).json({ error: 'TTS service error.' });
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    response.body.pipe(res);
  } catch (err) {
    console.error('TTS fetch error:', err);
    res.status(500).json({ error: 'Failed to generate speech.' });
  }
});

app.listen(PORT, () => {
  console.log(`Professor Viva is ready to judge at http://localhost:${PORT}`);
});
