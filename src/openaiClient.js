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
      "You are helping process creator collaboration emails.",
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
