export function terminalOptions(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  const json = argv.includes("--json");
  const noColor = argv.includes("--no-color") || env.NO_COLOR !== undefined || env.TERM === "dumb" || json;
  const color = (stream) => Boolean(stream.isTTY && !noColor &&
    (typeof stream.hasColors !== "function" || stream.hasColors(16, env)));
  return {
    color: color(stdout),
    statusColor: color(stderr),
    status: Boolean(stderr.isTTY && env.TERM !== "dumb" && !json && !argv.includes("--demo")),
    ascii: argv.includes("--ascii") || env.TERM === "dumb",
    width: stdout.columns || 80,
    interactive: Boolean(stdout.isTTY && env.TERM !== "dumb"),
    statusWidth: Math.max(1, (stderr.columns || 80) - 1),
  };
}
