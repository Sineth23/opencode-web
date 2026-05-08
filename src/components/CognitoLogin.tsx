import { createSignal, Show } from "solid-js";
import type { CognitoConfig } from "../utils/cognito";
import {
  initiateAuth,
  respondToNewPassword,
  respondToMFA,
  associateSoftwareToken,
  verifySoftwareToken,
  setUserMFAPreference,
  respondToMfaSetup,
  saveAuthState,
} from "../utils/cognito";

interface CognitoLoginProps {
  config: CognitoConfig;
  onSuccess: (idToken: string, accessToken: string) => void;
}

export default function CognitoLogin(props: CognitoLoginProps) {
  const [email, setEmail] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [mfaCode, setMfaCode] = createSignal("");
  const [newPassword, setNewPassword] = createSignal("");
  const [confirmPassword, setConfirmPassword] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal("");
  const [success, setSuccess] = createSignal("");
  const [loginType, setLoginType] = createSignal<"returning" | "firsttime">(
    "returning"
  );

  let cognitoSession = "";
  let cognitoAccessToken = "";
  let challengeName = "";

  const [currentStep, setCurrentStep] = createSignal(1);
  const [showMfaSection, setShowMfaSection] = createSignal(false);
  const [showNewPasswordSection, setShowNewPasswordSection] = createSignal(false);
  const [showMfaSetupSection, setShowMfaSetupSection] = createSignal(false);
  const [mfaSecret, setMfaSecret] = createSignal("");
  const [idToken, setIdToken] = createSignal("");

  const resetForm = () => {
    setEmail("");
    setPassword("");
    setMfaCode("");
    setNewPassword("");
    setConfirmPassword("");
    setError("");
    setSuccess("");
    setCurrentStep(1);
    setShowMfaSection(false);
    setShowNewPasswordSection(false);
    setShowMfaSetupSection(false);
    setMfaSecret("");
    setIdToken("");
    cognitoSession = "";
    cognitoAccessToken = "";
    challengeName = "";
  };

  const handleInitiate = async () => {
    if (!email().trim() || !password().trim()) {
      setError("Email and password are required");
      return;
    }

    setLoading(true);
    setError("");
    setSuccess("");

    try {
      const data = await initiateAuth(props.config, email(), password());

      cognitoSession = data.Session || "";
      challengeName = data.ChallengeName || "";

      if (data.AuthenticationResult) {
        const token = data.AuthenticationResult.IdToken;
        cognitoAccessToken = data.AuthenticationResult.AccessToken;
        setIdToken(token);
        saveAuthState(token, cognitoAccessToken);
        setSuccess("Login successful!");
        setTimeout(() => props.onSuccess(token, cognitoAccessToken), 500);
      } else if (challengeName === "NEW_PASSWORD_REQUIRED") {
        setShowNewPasswordSection(true);
        setCurrentStep(2);
        setSuccess("Please set a permanent password");
      } else if (challengeName === "SOFTWARE_TOKEN_MFA") {
        setShowMfaSection(true);
        setCurrentStep(2);
        setSuccess("Please enter your MFA code");
      } else if (challengeName === "MFA_SETUP") {
        await handleAssociate();
      } else {
        setError(`Unexpected challenge: ${challengeName}`);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleNewPassword = async () => {
    if (!newPassword() || newPassword() !== confirmPassword()) {
      setError("Passwords do not match or are empty");
      return;
    }

    if (newPassword().length < 12) {
      setError("Password must be at least 12 characters");
      return;
    }

    setLoading(true);
    setError("");
    setSuccess("");

    try {
      const data = await respondToNewPassword(
        props.config,
        cognitoSession,
        email(),
        newPassword()
      );

      setShowNewPasswordSection(false);

      if (data.AuthenticationResult) {
        const token = data.AuthenticationResult.IdToken;
        cognitoAccessToken = data.AuthenticationResult.AccessToken;
        setIdToken(token);
        saveAuthState(token, cognitoAccessToken);
        setSuccess("Password set! Logged in successfully");
        setTimeout(() => props.onSuccess(token, cognitoAccessToken), 500);
      } else if (data.ChallengeName === "MFA_SETUP") {
        cognitoSession = data.Session || "";
        challengeName = "MFA_SETUP";
        await handleAssociate();
      } else if (data.ChallengeName === "SOFTWARE_TOKEN_MFA") {
        cognitoSession = data.Session || "";
        challengeName = "SOFTWARE_TOKEN_MFA";
        setShowMfaSection(true);
        setCurrentStep(3);
        setSuccess("Please enter your MFA code");
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleMfa = async () => {
    if (!mfaCode() || mfaCode().length !== 6) {
      setError("Please enter a 6-digit MFA code");
      return;
    }

    setLoading(true);
    setError("");
    setSuccess("");

    try {
      const data = await respondToMFA(
        props.config,
        cognitoSession,
        email(),
        mfaCode()
      );

      if (data.AuthenticationResult) {
        const token = data.AuthenticationResult.IdToken;
        cognitoAccessToken = data.AuthenticationResult.AccessToken;
        setIdToken(token);
        saveAuthState(token, cognitoAccessToken);
        setSuccess("Login successful!");
        setTimeout(() => props.onSuccess(token, cognitoAccessToken), 500);
      } else {
        setError("MFA verification failed");
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleAssociate = async () => {
    setLoading(true);
    setError("");

    try {
      const data = await associateSoftwareToken(
        props.config,
        cognitoAccessToken || cognitoSession,
        !!cognitoAccessToken
      );

      if (data.Session) cognitoSession = data.Session;
      setMfaSecret(data.SecretCode);
      setShowMfaSetupSection(true);
      setShowMfaSection(true);
      setCurrentStep(3);
      setSuccess("Scan the QR code with your authenticator app");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyMfa = async () => {
    if (!mfaCode() || mfaCode().length !== 6) {
      setError("Please enter a 6-digit MFA code");
      return;
    }

    setLoading(true);
    setError("");
    setSuccess("");

    try {
      const data = await verifySoftwareToken(
        props.config,
        mfaCode(),
        cognitoAccessToken || cognitoSession,
        !!cognitoAccessToken
      );

      if (data.Status === "SUCCESS") {
        setShowMfaSetupSection(false);

        if (cognitoAccessToken) {
          await setUserMFAPreference(props.config, cognitoAccessToken);
          setSuccess("MFA enrolled and activated!");
        } else {
          cognitoSession = data.Session || cognitoSession;
          setCurrentStep(4);
          setSuccess("MFA verified! Completing setup...");
          setTimeout(() => handleMfaSetup(), 500);
        }
      } else {
        setError(`Unexpected status: ${data.Status}`);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleMfaSetup = async () => {
    setLoading(true);
    setError("");

    try {
      const data = await respondToMfaSetup(
        props.config,
        cognitoSession,
        email()
      );

      if (data.AuthenticationResult) {
        const token = data.AuthenticationResult.IdToken;
        cognitoAccessToken = data.AuthenticationResult.AccessToken;
        setIdToken(token);
        saveAuthState(token, cognitoAccessToken);
        setSuccess("Setup complete! Logged in successfully");
        setTimeout(() => props.onSuccess(token, cognitoAccessToken), 500);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div class="min-h-screen bg-gradient-to-br from-primary to-primary-focus flex items-center justify-center p-4">
      <div class="w-full max-w-md">
        <div class="card bg-base-100 shadow-xl">
          <div class="card-body">
            <div class="flex justify-center mb-6">
              <img src="/images/autodoc-logo.svg" alt="AutoDoc" class="h-12" />
            </div>

            <h1 class="text-center text-2xl font-bold mb-2">AutoDoc</h1>
            <p class="text-center text-base-content/70 mb-6">
              Sign in to your account
            </p>

            <div class="form-control w-full mb-4">
              <label class="label">
                <span class="label-text">Email</span>
              </label>
              <input
                type="email"
                placeholder="your@email.com"
                class="input input-bordered w-full"
                value={email()}
                onInput={(e) => setEmail(e.currentTarget.value)}
                disabled={loading()}
              />
            </div>

            <div class="form-control w-full mb-4">
              <label class="label">
                <span class="label-text">Password</span>
              </label>
              <input
                type="password"
                placeholder="••••••••"
                class="input input-bordered w-full"
                value={password()}
                onInput={(e) => setPassword(e.currentTarget.value)}
                disabled={loading()}
              />
            </div>

            <Show when={showNewPasswordSection()}>
              <div class="form-control w-full mb-4">
                <label class="label">
                  <span class="label-text">New Password</span>
                </label>
                <input
                  type="password"
                  placeholder="Min 12 chars, upper+lower+digit"
                  class="input input-bordered w-full"
                  value={newPassword()}
                  onInput={(e) => setNewPassword(e.currentTarget.value)}
                  disabled={loading()}
                />
              </div>

              <div class="form-control w-full mb-4">
                <label class="label">
                  <span class="label-text">Confirm Password</span>
                </label>
                <input
                  type="password"
                  placeholder="Confirm password"
                  class="input input-bordered w-full"
                  value={confirmPassword()}
                  onInput={(e) => setConfirmPassword(e.currentTarget.value)}
                  disabled={loading()}
                />
              </div>
            </Show>

            <Show when={showMfaSetupSection()}>
              <div class="alert alert-info mb-4">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  class="stroke-current shrink-0 w-6 h-6"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  ></path>
                </svg>
                <div>
                  <h3 class="font-bold">Setup MFA</h3>
                  <div class="text-sm">
                    Scan this code with your authenticator app:
                  </div>
                  <code class="block mt-2 p-2 bg-base-200 rounded text-xs break-all">
                    {mfaSecret()}
                  </code>
                </div>
              </div>
            </Show>

            <Show when={showMfaSection()}>
              <div class="form-control w-full mb-4">
                <label class="label">
                  <span class="label-text">MFA Code</span>
                </label>
                <input
                  type="text"
                  placeholder="123456"
                  maxLength="6"
                  class="input input-bordered w-full"
                  value={mfaCode()}
                  onInput={(e) => setMfaCode(e.currentTarget.value)}
                  disabled={loading()}
                />
              </div>
            </Show>

            <Show when={error()}>
              <div class="alert alert-error mb-4">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  class="stroke-current shrink-0 w-6 h-6"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M10 14l-2-2m0 0l-2-2m2 2l2-2m-2 2l-2 2m0 0l2 2m-2-2l2 2"
                  ></path>
                </svg>
                <span>{error()}</span>
              </div>
            </Show>

            <Show when={success()}>
              <div class="alert alert-success mb-4">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  class="stroke-current shrink-0 w-6 h-6"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M9 12l2 2 4-4"
                  ></path>
                </svg>
                <span>{success()}</span>
              </div>
            </Show>

            <div class="flex gap-2">
              <Show when={!showNewPasswordSection() && !showMfaSection()}>
                <button
                  class="btn btn-primary w-full"
                  disabled={loading()}
                  onClick={handleInitiate}
                >
                  <Show when={loading()} fallback="Sign In">
                    <span class="loading loading-spinner loading-sm"></span>
                  </Show>
                </button>
              </Show>

              <Show when={showNewPasswordSection()}>
                <button
                  class="btn btn-primary w-full"
                  disabled={loading()}
                  onClick={handleNewPassword}
                >
                  <Show when={loading()} fallback="Set Password">
                    <span class="loading loading-spinner loading-sm"></span>
                  </Show>
                </button>
              </Show>

              <Show when={showMfaSection() && !showMfaSetupSection()}>
                <button
                  class="btn btn-primary w-full"
                  disabled={loading()}
                  onClick={handleMfa}
                >
                  <Show when={loading()} fallback="Verify MFA">
                    <span class="loading loading-spinner loading-sm"></span>
                  </Show>
                </button>
              </Show>

              <Show when={showMfaSetupSection()}>
                <button
                  class="btn btn-primary w-full"
                  disabled={loading()}
                  onClick={handleVerifyMfa}
                >
                  <Show when={loading()} fallback="Complete MFA Setup">
                    <span class="loading loading-spinner loading-sm"></span>
                  </Show>
                </button>
              </Show>
            </div>

            <button
              class="btn btn-ghost btn-sm w-full mt-2"
              onClick={resetForm}
              disabled={loading()}
            >
              Clear Form
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
