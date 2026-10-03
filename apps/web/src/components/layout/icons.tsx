/**
 * Icons.
 *
 * Inline SVG rather than an icon package: there are a dozen of them, they need
 * to inherit `currentColor` so the status pairing works, and shipping a whole
 * icon font to a hospital workstation on a slow link for twelve glyphs is not
 * a good trade.
 *
 * All are 20×20 on a 24-unit grid, stroked at 1.75 so they sit optically with
 * the 15px body text.
 */
import type { ReactNode, SVGProps } from 'react';

function Icon({ children, ...rest }: SVGProps<SVGSVGElement> & { children: ReactNode }): ReactNode {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconDashboard = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <rect x="3" y="3" width="7" height="9" rx="1.5" />
    <rect x="14" y="3" width="7" height="5" rx="1.5" />
    <rect x="14" y="12" width="7" height="9" rx="1.5" />
    <rect x="3" y="16" width="7" height="5" rx="1.5" />
  </Icon>
);

export const IconPatients = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <circle cx="9" cy="8" r="3.25" />
    <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
    <path d="M16 11.5a3 3 0 1 0 0-6" />
    <path d="M17 20a5.4 5.4 0 0 0-1.8-4" />
  </Icon>
);

export const IconCalendar = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M3 10h18M8 3v4M16 3v4" />
  </Icon>
);

export const IconStethoscope = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M5 3v5a4 4 0 0 0 8 0V3" />
    <path d="M9 12v3a5 5 0 0 0 5 5 4 4 0 0 0 4-4v-2.5" />
    <circle cx="18" cy="11" r="2" />
  </Icon>
);

export const IconPill = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <rect x="2.5" y="8" width="19" height="8" rx="4" transform="rotate(-45 12 12)" />
    <path d="M9 9l6 6" />
  </Icon>
);

export const IconBox = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M21 8.5v7a2 2 0 0 1-1 1.73l-7 4a2 2 0 0 1-2 0l-7-4A2 2 0 0 1 3 15.5v-7" />
    <path d="M3.3 7.4l8.7 4.9 8.7-4.9" />
    <path d="M12 22v-9.7" />
    <path d="M3.3 7.4L12 2.5l8.7 4.9" />
  </Icon>
);

export const IconReceipt = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2V3Z" />
    <path d="M9 8h6M9 12h6" />
  </Icon>
);

export const IconStaff = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <circle cx="12" cy="7" r="3.5" />
    <path d="M5 21a7 7 0 0 1 14 0" />
    <path d="M12 11.5v3M10.5 13h3" />
  </Icon>
);

export const IconChart = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
  </Icon>
);

export const IconSettings = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
  </Icon>
);

export const IconSearch = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="M16.5 16.5L21 21" />
  </Icon>
);

export const IconBell = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8" />
    <path d="M10.3 21a2 2 0 0 0 3.4 0" />
  </Icon>
);

export const IconSun = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Icon>
);

export const IconMoon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
  </Icon>
);

export const IconLogout = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
    <path d="M10 17l-5-5 5-5M5 12h10" />
  </Icon>
);

export const IconMenu = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M3 6h18M3 12h18M3 18h18" />
  </Icon>
);

export const IconClose = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
);

export const IconAlert = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M12 3l9.5 17H2.5L12 3Z" />
    <path d="M12 9v5M12 17.5v.01" />
  </Icon>
);

export const IconPlus = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const IconChevronRight = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M9 6l6 6-6 6" />
  </Icon>
);

export const IconShield = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M12 2.5l8 3v6c0 5-3.4 8.7-8 10-4.6-1.3-8-5-8-10v-6l8-3Z" />
    <path d="M9.5 12l1.8 1.8 3.4-3.6" />
  </Icon>
);
