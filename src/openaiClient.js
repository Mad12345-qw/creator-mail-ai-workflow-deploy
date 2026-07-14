export class OpenAIClient {
  constructor(config) {
    this.config = config;
  }

  isConfigured() {
    if (this.config.aiProvider === "deepseek") {
      return Boolean(this.config.deepseek.apiKey);
    }
    return Boolean(this.config.openai.apiKey);
  }

  async analyzeEmail(email, context) {
    if (!this.isConfigured()) {
      return {
        skipped: true,
        intent: "unconfigured",
        riskLevel: "Medium",
        action: "manual_review",
        summary: "GPT is not configured yet.",
        extracted: {}
      };
    }

    const prompt = [
      "You are the brand/company partnership team processing creator collaboration emails.",
      "The incoming email sender is the creator. Write draftReply as our brand/company replying to that creator.",
      "Use we/our for the brand and you/your for the creator. Never impersonate the creator, claim to be an influencer, say that we applied for a sample, or ask the brand to send us a product.",
      "Do not approve or promise rates, fees, payment, contracts, shipping, or commercial terms unless the supplied context explicitly authorizes them.",
      "Do not include placeholders, internal review language, AI/system commentary, or duplicate sign-offs in draftReply.",
      "Use only the provided context. Do not invent rates, commission, links, payment terms, or agreement terms.",
      "Return strict JSON with keys: intent, riskLevel, action, summary, extracted, draftReply.",
      `Email: ${JSON.stringify(email)}`,
      `Context: ${JSON.stringify(context)}`
    ].join("\n\n");

    if (this.config.aiProvider === "deepseek") {
      return this.analyzeWithDeepSeek(prompt);
    }

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.openai.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: this.config.openai.model,
        input: prompt
      })
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(`OpenAI request failed: ${data.error?.message || response.statusText}`);
    }

    const text = data.output_text || "";
    try {
      return JSON.parse(text);
    } catch {
      return {
        intent: "needs_review",
        riskLevel: "Medium",
        action: "manual_review",
        summary: text.slice(0, 1000),
        extracted: {},
        draftReply: ""
      };
    }
  }

  async analyzeWithDeepSeek(prompt) {
    const response = await fetch(`${this.config.deepseek.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.deepseek.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: this.config.deepseek.model,
        temperature: 0,
        messages: [
          {
            role: "system",
            content: "Return strict JSON only. Do not wrap the result in Markdown."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        response_format: { type: "json_object" }
      })
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(`DeepSeek request failed: ${data.error?.message || response.statusText}`);
    }

    const text = data.choices?.[0]?.message?.content || "";
    try {
      return JSON.parse(text);
    } catch {
      return {
        intent: "needs_review",
        riskLevel: "Medium",
        action: "manual_review",
        summary: text.slice(0, 1000),
        extracted: {},
        draftReply: ""
      };
    }
  }
}
