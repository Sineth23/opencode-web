export interface CognitoConfig {
  clientId: string;
  userPoolId: string;
  region: string;
  endpoint: string;
}

export interface AuthState {
  idToken: string | null;
  accessToken: string | null;
  userId: string | null;
  email: string | null;
}

const COGNITO_SESSION_KEY = "cognito_session";
const COGNITO_ACCESS_TOKEN_KEY = "cognito_access_token";
const COGNITO_ID_TOKEN_KEY = "cognito_id_token";

async function cognitoRequest(
  config: CognitoConfig,
  action: string,
  payload: Record<string, any>
) {
  const url = config.endpoint;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": `AWSCognitoIdentityProviderService.${action}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.message || JSON.stringify(data));
  }

  return data;
}

export async function initiateAuth(
  config: CognitoConfig,
  email: string,
  password: string
) {
  return cognitoRequest(config, "InitiateAuth", {
    AuthFlow: "USER_PASSWORD_AUTH",
    ClientId: config.clientId,
    AuthParameters: {
      USERNAME: email,
      PASSWORD: password,
    },
  });
}

export async function respondToNewPassword(
  config: CognitoConfig,
  session: string,
  email: string,
  newPassword: string
) {
  return cognitoRequest(config, "RespondToAuthChallenge", {
    ClientId: config.clientId,
    ChallengeName: "NEW_PASSWORD_REQUIRED",
    Session: session,
    ChallengeResponses: {
      USERNAME: email,
      NEW_PASSWORD: newPassword,
    },
  });
}

export async function respondToMFA(
  config: CognitoConfig,
  session: string,
  email: string,
  mfaCode: string
) {
  return cognitoRequest(config, "RespondToAuthChallenge", {
    ClientId: config.clientId,
    ChallengeName: "SOFTWARE_TOKEN_MFA",
    Session: session,
    ChallengeResponses: {
      USERNAME: email,
      SOFTWARE_TOKEN_MFA_CODE: mfaCode,
    },
  });
}

export async function associateSoftwareToken(
  config: CognitoConfig,
  sessionOrToken: string,
  isAccessToken: boolean = false
) {
  const payload: Record<string, any> = {};
  if (isAccessToken) {
    payload.AccessToken = sessionOrToken;
  } else {
    payload.Session = sessionOrToken;
  }

  return cognitoRequest(config, "AssociateSoftwareToken", payload);
}

export async function verifySoftwareToken(
  config: CognitoConfig,
  mfaCode: string,
  sessionOrToken: string,
  isAccessToken: boolean = false
) {
  const payload: Record<string, any> = {
    UserCode: mfaCode,
    FriendlyDeviceName: "AutoDoc",
  };

  if (isAccessToken) {
    payload.AccessToken = sessionOrToken;
  } else {
    payload.Session = sessionOrToken;
  }

  return cognitoRequest(config, "VerifySoftwareToken", payload);
}

export async function setUserMFAPreference(
  config: CognitoConfig,
  accessToken: string
) {
  return cognitoRequest(config, "SetUserMFAPreference", {
    AccessToken: accessToken,
    SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: true },
  });
}

export async function respondToMfaSetup(
  config: CognitoConfig,
  session: string,
  email: string
) {
  return cognitoRequest(config, "RespondToAuthChallenge", {
    ClientId: config.clientId,
    ChallengeName: "MFA_SETUP",
    Session: session,
    ChallengeResponses: {
      USERNAME: email,
    },
  });
}

export function saveAuthState(idToken: string, accessToken: string) {
  localStorage.setItem(COGNITO_ID_TOKEN_KEY, idToken);
  localStorage.setItem(COGNITO_ACCESS_TOKEN_KEY, accessToken);
}

export function loadAuthState(): AuthState {
  const idToken = localStorage.getItem(COGNITO_ID_TOKEN_KEY);
  const accessToken = localStorage.getItem(COGNITO_ACCESS_TOKEN_KEY);

  if (!idToken) {
    return {
      idToken: null,
      accessToken: null,
      userId: null,
      email: null,
    };
  }

  try {
    const payload = JSON.parse(atob(idToken.split(".")[1]));
    return {
      idToken,
      accessToken,
      userId: payload.sub || null,
      email: payload.email || null,
    };
  } catch {
    clearAuthState();
    return {
      idToken: null,
      accessToken: null,
      userId: null,
      email: null,
    };
  }
}

export function clearAuthState() {
  localStorage.removeItem(COGNITO_ID_TOKEN_KEY);
  localStorage.removeItem(COGNITO_ACCESS_TOKEN_KEY);
}

export function isAuthenticated(): boolean {
  const state = loadAuthState();
  if (!state.idToken) return false;

  try {
    const payload = JSON.parse(atob(state.idToken.split(".")[1]));
    const expiresAt = (payload.exp || 0) * 1000;
    const now = Date.now();
    if (now > expiresAt) {
      clearAuthState();
      return false;
    }
    return true;
  } catch {
    clearAuthState();
    return false;
  }
}

export function getTenantId(): string | null {
  const state = loadAuthState();
  if (!state.idToken) return null;

  try {
    const payload = JSON.parse(atob(state.idToken.split(".")[1]));
    return payload["custom:tenantId"] || null;
  } catch {
    return null;
  }
}

export function getTenantInfo() {
  const state = loadAuthState();
  if (!state.idToken) return null;

  try {
    const payload = JSON.parse(atob(state.idToken.split(".")[1]));
    return {
      tenantId: payload["custom:tenantId"] || null,
      tenantRole: payload["custom:tenantRole"] || null,
      userId: payload.sub || null,
      email: payload.email || null,
    };
  } catch {
    return null;
  }
}
