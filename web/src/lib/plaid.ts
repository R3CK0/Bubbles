/** Plaid Link loader — injects the SDK once and opens Link with a token. */

declare global {
  interface Window {
    Plaid?: {
      create(opts: {
        token: string;
        onSuccess: (publicToken: string, metadata: unknown) => void;
        onExit?: (err: unknown) => void;
      }): { open(): void };
    };
  }
}

let loading: Promise<void> | null = null;

function loadSdk(): Promise<void> {
  if (window.Plaid) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("failed to load Plaid Link SDK"));
    document.head.appendChild(s);
  });
  return loading;
}

export async function openPlaidLink(linkToken: string): Promise<string | null> {
  await loadSdk();
  return new Promise((resolve) => {
    window.Plaid!.create({
      token: linkToken,
      onSuccess: (publicToken) => resolve(publicToken),
      onExit: () => resolve(null),
    }).open();
  });
}
