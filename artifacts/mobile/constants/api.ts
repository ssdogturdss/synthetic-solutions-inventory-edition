function normalizeDomain(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  const candidate = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  try {
    const url = new URL(candidate);
    if (
      !url.hostname ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return url.host;
  } catch {
    return null;
  }
}

// The deployment domain is always injected explicitly at build time.
export const API_DOMAIN = normalizeDomain(process.env.EXPO_PUBLIC_DOMAIN);

export const API_BASE_URL = API_DOMAIN ? `https://${API_DOMAIN}` : null;