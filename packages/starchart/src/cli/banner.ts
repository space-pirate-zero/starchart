/**
 * SPZ-branded ASCII art for the CLI. Plain text here; {@link renderBanner} adds NEON color
 * (hot pink #ff1493 ≈ ANSI 198, phosphor green #00ff41 ≈ ANSI 46) when the terminal supports it.
 */

export const LOGO = "███████╗████████╗ █████╗ ██████╗  ██████╗██╗  ██╗ █████╗ ██████╗ ████████╗\n██╔════╝╚══██╔══╝██╔══██╗██╔══██╗██╔════╝██║  ██║██╔══██╗██╔══██╗╚══██╔══╝\n███████╗   ██║   ███████║██████╔╝██║     ███████║███████║██████╔╝   ██║\n╚════██║   ██║   ██╔══██║██╔══██╗██║     ██╔══██║██╔══██║██╔══██╗   ██║\n███████║   ██║   ██║  ██║██║  ██║╚██████╗██║  ██║██║  ██║██║  ██║   ██║\n╚══════╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝";

export const TAGLINE = "☠ EVERY DEPENDENCY. CODE TO COSMOS. ────────── A SPACE PIRATE ZERO JOINT ☠";

export const BANNER = "  ·      ✦          ·        ★            ·          ✦         ·       ·\n███████╗████████╗ █████╗ ██████╗  ██████╗██╗  ██╗ █████╗ ██████╗ ████████╗\n██╔════╝╚══██╔══╝██╔══██╗██╔══██╗██╔════╝██║  ██║██╔══██╗██╔══██╗╚══██╔══╝\n███████╗   ██║   ███████║██████╔╝██║     ███████║███████║██████╔╝   ██║\n╚════██║   ██║   ██╔══██║██╔══██╗██║     ██╔══██║██╔══██║██╔══██╗   ██║\n███████║   ██║   ██║  ██║██║  ██║╚██████╗██║  ██║██║  ██║██║  ██║   ██║\n╚══════╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝\n☠ EVERY DEPENDENCY. CODE TO COSMOS. ────────── A SPACE PIRATE ZERO JOINT ☠\n     ·         ·         ✦           ·          ★          ·         ·";

export const JOLLY_ROGER = "        ·              ✦                ·\n    ★               _________               ·\n                .-'           '-.\n     ·         /                 \\         ✦\n              |   .---.   .---.   |\n              |   ( ✦ )   ( ✦ )   |\n      ✦        \\  '---'   '---'  /        ·\n                '.     /_\\     .'\n                  |'|'|'|'|'|'|\n                  '-._______.-'\n                        ·\n      \\\\\\\\\\\\                         //////\n           >=======   S P Z   =======<\n      //////                         \\\\\\\\\\\\\n            ·           ★           ·";

/** Width of the full banner; narrower terminals get the one-line mark. */
export const BANNER_WIDTH = 74;

export const COMPACT = "★ STARCHART — every dependency. code to cosmos. ☠ a Space Pirate Zero joint";

const PINK = (s: string) => `\x1b[38;5;198m${s}\x1b[39m`;
const GREEN = (s: string) => `\x1b[38;5;46m${s}\x1b[39m`;
const GOLD = (s: string) => `\x1b[38;5;220m${s}\x1b[39m`;
const DIM = (s: string) => `\x1b[2m${s}\x1b[22m`;

export interface BannerOptions {
  color?: boolean;
  /** Terminal width; below the banner width the compact mark is used. */
  columns?: number;
}

/** The banner, colored for a NEON terminal or plain for pipes, logs and NO_COLOR. */
export function renderBanner(opts: BannerOptions = {}): string {
  const color = opts.color ?? false;
  if (opts.columns !== undefined && opts.columns < BANNER_WIDTH + 2) {
    return color ? `${PINK("★ STARCHART")} ${DIM("— every dependency. code to cosmos.")} ${GREEN("☠ a Space Pirate Zero joint")}` : COMPACT;
  }
  if (!color) return BANNER;
  return BANNER.split("\n")
    .map((line) => {
      if (/[█╗╔╝╚═║]/.test(line) && !line.startsWith("☠")) return PINK(line);
      if (line.startsWith("☠")) return line.replace(/☠/g, PINK("☠")).replace(/(EVERY DEPENDENCY\. CODE TO COSMOS\.)/, GREEN("$1")).replace(/(A SPACE PIRATE ZERO JOINT)/, GREEN("$1")).replace(/(─+)/, DIM("$1"));
      return line.replace(/[★✦]/g, (m) => GOLD(m)).replace(/·/g, (m) => DIM(m));
    })
    .join("\n");
}

/** The Jolly Roger for `starchart about`. */
export function renderJollyRoger(opts: BannerOptions = {}): string {
  if (!opts.color) return JOLLY_ROGER;
  return JOLLY_ROGER.split("\n")
    .map((line) =>
      line
        .replace(/S P Z/, GREEN("S P Z"))
        .replace(/[★✦]/g, (m) => GOLD(m))
        .replace(/·/g, (m) => DIM(m))
        .replace(/([\\/|'.\-_()>=<]+)/g, (m) => PINK(m)),
    )
    .join("\n");
}
