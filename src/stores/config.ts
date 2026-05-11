import { createSignal, createEffect } from 'solid-js';

const STORAGE_KEY = 'opencode-config';

export const AVAILABLE_THEMES = [
  'light', 'dark', 'cupcake', 'bumblebee', 'emerald', 'corporate',
  'synthwave', 'retro', 'cyberpunk', 'valentine', 'halloween', 'garden',
  'forest', 'aqua', 'lofi', 'pastel', 'fantasy', 'wireframe', 'black',
  'luxury', 'dracula', 'cmyk', 'autumn', 'business', 'acid', 'lemonade',
  'night', 'coffee', 'winter', 'dim', 'nord', 'sunset'
] as const;

export type Theme = typeof AVAILABLE_THEMES[number];

export interface CognitoSettings {
  clientId: string;
  userPoolId: string;
  region: string;
  endpoint: string;
}

interface Config {
  apiEndpoint: string;
  theme: Theme;
  cognito?: CognitoSettings;
}

const defaultConfig: Config = {
  apiEndpoint: '',
  theme: 'dark',
};

function loadCognitoConfig(): CognitoSettings | undefined {
  const env = (import.meta as any).env;
  if (
    env?.VITE_COGNITO_CLIENT_ID &&
    env?.VITE_COGNITO_USER_POOL_ID &&
    env?.VITE_COGNITO_REGION
  ) {
    const region = env.VITE_COGNITO_REGION as string;
    return {
      clientId: env.VITE_COGNITO_CLIENT_ID as string,
      userPoolId: env.VITE_COGNITO_USER_POOL_ID as string,
      region,
      endpoint: `https://cognito-idp.${region}.amazonaws.com/`,
    };
  }
  return undefined;
}

function loadConfig(): Config {
  const stored = localStorage.getItem(STORAGE_KEY);
  let cfg = defaultConfig;
  if (stored) {
    try {
      cfg = { ...defaultConfig, ...JSON.parse(stored) };
    } catch (e) {
      console.error('Failed to parse stored config:', e);
    }
  }
  const fromEnv = (import.meta as any).env?.VITE_API_DEFAULT as string | undefined;
  if (!cfg.apiEndpoint && fromEnv) {
    cfg = { ...cfg, apiEndpoint: fromEnv };
  }
  cfg.cognito = loadCognitoConfig();
  return cfg;
}

function saveConfig(config: Config) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

export const [config, setConfig] = createSignal<Config>(loadConfig());

createEffect(() => {
  saveConfig(config());
  document.documentElement.setAttribute('data-theme', config().theme);
});

export function updateApiEndpoint(endpoint: string) {
  setConfig((c) => ({ ...c, apiEndpoint: endpoint }));
}

export function updateTheme(theme: Theme) {
  setConfig((c) => ({ ...c, theme }));
}
