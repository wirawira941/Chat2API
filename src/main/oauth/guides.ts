export interface TokenExtractionGuide {
  loginUrl: string
  steps: string[]
  tokenKey: string
  tokenLabel: string
  storageType: 'localStorage' | 'cookie' | 'other'
  placeholder?: string
  helpUrl?: string
}

/**
 * `steps` is shown on phones as well as desktops, so it never assumes DevTools.
 * The bookmarklet below the list does the actual extraction; the DevTools path
 * is only mentioned as a fallback for desktop users who prefer it.
 */
export const TOKEN_EXTRACTION_GUIDES: Record<string, TokenExtractionGuide> = {
  deepseek: {
    loginUrl: 'https://chat.deepseek.com',
    steps: [
      'Open chat.deepseek.com and log in normally in your browser',
      'Copy the token with the bookmarklet below (phone steps are listed under it)',
      'Paste the token into the field at the bottom of this panel',
    ],
    tokenKey: 'userToken',
    tokenLabel: 'Token',
    storageType: 'localStorage',
    placeholder: 'Paste the Token obtained from DeepSeek',
  },
  qwen: {
    loginUrl: 'https://www.qianwen.com',
    steps: [
      'Open www.qianwen.com and log in normally in your browser',
      'Copy the ticket with the bookmarklet below (phone steps are listed under it)',
      'Paste the ticket into the field at the bottom of this panel',
    ],
    tokenKey: 'tongyi_sso_ticket',
    tokenLabel: 'Ticket',
    storageType: 'cookie',
    placeholder: 'Paste the Ticket obtained from Qwen',
  },
  'qwen-ai': {
    loginUrl: 'https://chat.qwen.ai',
    steps: [
      'Open chat.qwen.ai and log in normally in your browser',
      'Copy the token with the bookmarklet below (phone steps are listed under it)',
      'Paste the token into the field at the bottom of this panel',
    ],
    tokenKey: 'token',
    tokenLabel: 'Token',
    storageType: 'localStorage',
    placeholder: 'Paste the JWT token obtained from chat.qwen.ai',
  },
  qwenAi: {
    loginUrl: 'https://chat.qwen.ai',
    steps: [
      'Open chat.qwen.ai and log in normally in your browser',
      'Copy the token with the bookmarklet below (phone steps are listed under it)',
      'Paste the token into the field at the bottom of this panel',
    ],
    tokenKey: 'token',
    tokenLabel: 'Token',
    storageType: 'localStorage',
    placeholder: 'Paste the JWT token obtained from chat.qwen.ai',
  },
  glm: {
    loginUrl: 'https://chatglm.cn',
    steps: [
      'Open chatglm.cn and log in normally in your browser',
      'Copy the refresh token with the bookmarklet below (phone steps are listed under it)',
      'Paste it into the field at the bottom of this panel — exchanged server-side for access token',
    ],
    tokenKey: 'chatglm_refresh_token',
    tokenLabel: 'Refresh Token',
    storageType: 'localStorage',
    placeholder: 'Paste the refresh_token obtained from chatglm.cn',
  },
  kimi: {
    loginUrl: 'https://www.kimi.com',
    steps: [
      'Open www.kimi.com and log in normally in your browser',
      'Copy the token with the bookmarklet below (phone steps are listed under it)',
      'Paste the token into the field at the bottom of this panel',
      'Fallback: DevTools → Network → any API request → Authorization header, after "Bearer"',
    ],
    tokenKey: 'authorization',
    tokenLabel: 'Token',
    storageType: 'other',
    placeholder: 'Paste the Token obtained from Kimi',
  },
  minimax: {
    loginUrl: 'https://www.minimaxi.com',
    steps: [
      'Open www.minimaxi.com and log in normally in your browser',
      'Copy the token with the bookmarklet below (phone steps are listed under it)',
      'Paste the token into the field at the bottom of this panel',
    ],
    tokenKey: 'token',
    tokenLabel: 'Token',
    storageType: 'localStorage',
    placeholder: 'Paste the Token obtained from MiniMax',
  },
}

export function getGuideByProvider(providerType: string): TokenExtractionGuide | undefined {
  return TOKEN_EXTRACTION_GUIDES[providerType]
}
