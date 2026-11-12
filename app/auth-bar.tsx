import { Show, SignInButton, UserButton } from "@clerk/nextjs";

/** Thin top bar: sign-in button for guests, UserButton for signed-in users. */
export function AuthBar() {
  return (
    <div className="auth-bar">
      <div className="container auth-bar-inner">
        <Show when="signed-out">
          <SignInButton mode="modal">
            <button className="btn btn-ghost" type="button">
              Sign in
            </button>
          </SignInButton>
        </Show>
        <Show when="signed-in">
          <UserButton />
        </Show>
      </div>
    </div>
  );
}

