/** Which env file the npm script loaded: `ENV=prod pnpm ...` -> .env.prod, default dev. */
export function envBanner(env: string | undefined): string {
  const name = env || 'dev';
  const line = `Environment: ${name} (.env.${name})`;
  return name === 'prod' ? `⚠  ${line}  <-- PRODUCTION` : line;
}

export function printEnvBanner(): void {
  console.log(envBanner(process.env.ENV));
}
