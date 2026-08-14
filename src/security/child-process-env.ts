const SENSITIVE_NAME =
  /(?:^|_)(?:API_?KEY|ACCESS_?KEY(?:_ID)?|APP_?KEY|PRIVATE_?KEY|SECRET(?:_KEY)?|TOKEN|PASSWORD|PASSWD|COOKIE|CREDENTIALS?|AUTHORIZATION)(?:$|_)/i;

const PROXY_NAME = /^(?:HTTP|HTTPS|ALL|NO)_PROXY$|^(?:NPM_CONFIG_)?(?:HTTP|HTTPS|ALL)_PROXY$/i;

function containsUrlCredentials(value: string): boolean {
  try {
    const url = new URL(value);
    return url.username.length > 0 || url.password.length > 0;
  } catch {
    return false;
  }
}

/** Sanitized environment for model-initiated commands; subsystems may add explicit user-configured overlays. */
export function sanitizedChildProcessEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || SENSITIVE_NAME.test(name)) continue;
    if (PROXY_NAME.test(name) && containsUrlCredentials(value)) continue;
    if (containsUrlCredentials(value)) continue;
    out[name] = value;
  }
  return out;
}
