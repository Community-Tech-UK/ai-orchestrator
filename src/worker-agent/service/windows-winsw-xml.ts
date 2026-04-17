export interface WinswXmlOptions {
  serviceId: string;
  displayName: string;
  description: string;
  executable: string;
  arguments: string[];
  logDir: string;
  serviceAccount?: string;
  env?: Record<string, string>;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function generateWinswXml(opts: WinswXmlOptions): string {
  const args = opts.arguments.map((a) => `  <argument>${escapeXml(a)}</argument>`).join('\n');
  const envBlock = opts.env
    ? Object.entries(opts.env)
        .map(([k, v]) => `  <env name="${escapeXml(k)}" value="${escapeXml(v)}"/>`)
        .join('\n')
    : '';
  const accountBlock = opts.serviceAccount
    ? `  <serviceaccount>\n    <username>${escapeXml(opts.serviceAccount)}</username>\n    <allowservicelogon>true</allowservicelogon>\n  </serviceaccount>`
    : '';
  return `<service>
  <id>${escapeXml(opts.serviceId)}</id>
  <name>${escapeXml(opts.displayName)}</name>
  <description>${escapeXml(opts.description)}</description>
  <executable>${escapeXml(opts.executable)}</executable>
${args}
  <logpath>${escapeXml(opts.logDir)}</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>5</keepFiles>
  </log>
  <onfailure action="restart" delay="10 sec"/>
  <startmode>Automatic</startmode>
  <delayedAutoStart>true</delayedAutoStart>
${envBlock}
${accountBlock}
</service>`;
}
