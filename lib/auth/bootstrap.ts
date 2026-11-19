/** Exact (case- and whitespace-insensitive) match against BOOTSTRAP_ADMIN_EMAIL. */
export function isBootstrapAdminEmail(
  email: string | null | undefined,
  configured: string | null | undefined,
): boolean {
  if (!email || !configured) return false;
  return email.trim().toLowerCase() === configured.trim().toLowerCase();
}
