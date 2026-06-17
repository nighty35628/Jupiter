export interface LightAskRouteOptions {
  planOneShot?: boolean;
}

const MAX_LIGHT_ASK_CHARS = 240;

const AGENT_INTENT_PATTERNS = [
  /^\/\S+/,
  /(?:^|\s)(?:src|desktop|tests|scripts|docs|packages|dist|README|package\.json|Cargo\.toml|\.tsx?|\.jsx?|\.mts|\.md|\.json|\.rs|\.py)(?:\/|\b|$)/i,
  /\b(?:fix|debug|implement|refactor|edit|modify|delete|rename|commit|push|pull request|pr|branch|merge|run|test|build|lint|typecheck|install|search|browse|open|read|write|create|generate|import|export)\b/i,
  /(?:修复|调试|实现|重构|修改|删除|重命名|提交|推送|合并|分支|运行|测试|构建|安装|搜索|打开|读取|写入|新建|生成|导入|导出|资料库|文件|代码|仓库|项目|工作区|终端|浏览器|计划|压缩上下文|折叠上下文)/,
];

const CASUAL_HINT_PATTERNS = [
  /^(?:hi|hello|hey|thanks|thank you|ok|okay|yes|no)\b/i,
  /^(?:你好|您好|谢谢|多谢|好的|好|嗯|可以|不用|没事|再见|早上好|晚上好)[。！？!?.\s]*$/,
  /(?:讲个笑话|开个玩笑|随便聊聊|你是谁|who are you|what are you)/i,
  /^(?:what is|what's|explain|解释一下|简单解释|说说|聊聊)\b/i,
];

export function shouldUseLightAskForDesktopInput(
  input: string,
  opts: LightAskRouteOptions = {},
): boolean {
  if (opts.planOneShot) return false;
  const text = input.trim();
  if (!text) return false;
  if (text.length > MAX_LIGHT_ASK_CHARS) return false;
  if (AGENT_INTENT_PATTERNS.some((pattern) => pattern.test(text))) return false;
  if (CASUAL_HINT_PATTERNS.some((pattern) => pattern.test(text))) return true;
  if (!/[?？]/.test(text)) return false;
  return !/[`/\\{}[\]<>]|(?:怎么|如何|why|how).*(?:改|修|做|实现|代码|file|code|repo|project)/i.test(
    text,
  );
}
