import { Show, SignInButton, UserButton } from "@clerk/nextjs";

/**
 * Thin top bar on the landing site. Guests: "Sign in", which lands in the
 * workspace afterwards. Signed in: "Open workspace" plus the profile button.
 */
export function AuthBar() {
  return (
    <div className="auth-bar">
      <div className="container auth-bar-inner">
        <Show when="signed-out">
          <SignInButton mode="modal" forceRedirectUrl="/app" signUpForceRedirectUrl="/app">
            <button className="btn btn-ghost" type="button">
              Sign in
            </button>
          </SignInButton>
        </Show>
        <Show when="signed-in">
          <a className="btn btn-ghost" href="/app">
            Open workspace
          </a>
          <UserButton />
        </Show>
      </div>
    </div>
  );
}
