import { needsSshLogin } from "./ControlClient";

// A host that wants an interactive login has refused the action, not failed it.
// The second attempt sits outside the try, so a host that refuses again reports
// that refusal rather than starting another login.
export async function withSshLogin<T>(
  action: () => Promise<T>,
  login: () => Promise<void>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (!needsSshLogin(error)) {
      throw error;
    }
    await login();
    return action();
  }
}
