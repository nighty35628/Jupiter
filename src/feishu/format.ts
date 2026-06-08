const FEISHU_MARKDOWN_CARD_MAX_CHARS = 6000;

export type FeishuMarkdownCard = {
  config: {
    wide_screen_mode: boolean;
  };
  header?: {
    template: string;
    title: {
      tag: "plain_text";
      content: string;
    };
  };
  elements: Array<{
    tag: "markdown";
    content: string;
  }>;
};

export function splitFeishuMarkdown(
  text: string,
  maxChars = FEISHU_MARKDOWN_CARD_MAX_CHARS,
): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, maxChars));
    remaining = remaining.slice(maxChars);
  }
  return chunks.length > 0 ? chunks : ["(empty response)"];
}

export function buildFeishuMarkdownCard(text: string, title = "Jupiter"): FeishuMarkdownCard {
  const content = text.trim() || "(empty response)";
  return {
    config: {
      wide_screen_mode: true,
    },
    header: {
      template: "blue",
      title: {
        tag: "plain_text",
        content: title,
      },
    },
    elements: [
      {
        tag: "markdown",
        content,
      },
    ],
  };
}
