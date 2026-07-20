import type { SVGProps } from "react";

export interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number;
}

const IconBase = ({ children, size = 20, className, ...props }: IconProps) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="none"
    height={size}
    viewBox="0 0 24 24"
    width={size}
    {...props}
  >
    {children}
  </svg>
);

export const SparkIcon = (props: IconProps) => (
  <IconBase {...props}>
    <path
      d="M12 2.8c.25 5.4 2.4 7.7 7.7 8.2-5.2.55-7.45 2.8-7.7 8.2-.3-5.35-2.55-7.65-7.7-8.2 5.2-.5 7.4-2.8 7.7-8.2Z"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.65"
    />
    <path
      d="M19.2 3.8c.1 1.65.8 2.35 2.4 2.55-1.6.15-2.3.85-2.4 2.5-.15-1.65-.85-2.35-2.4-2.5 1.6-.2 2.25-.9 2.4-2.55Z"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.35"
    />
  </IconBase>
);

export const ArrowIcon = (props: IconProps) => (
  <IconBase {...props}>
    <path
      d="M4 12.4c4.2-.15 8.1-.1 15.5-.2"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="1.8"
    />
    <path
      d="m15.2 7.8 4.5 4.35-4.3 4.25"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
    />
  </IconBase>
);

export const SunIcon = (props: IconProps) => (
  <IconBase {...props}>
    <circle cx="12" cy="12" r="3.3" stroke="currentColor" strokeWidth="1.7" />
    <path
      d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="1.7"
    />
  </IconBase>
);

export const MoonIcon = (props: IconProps) => (
  <IconBase {...props}>
    <path
      d="M20.2 15.1A8.5 8.5 0 0 1 8.9 3.8 8.6 8.6 0 1 0 20.2 15Z"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
    />
  </IconBase>
);

export const CheckIcon = (props: IconProps) => (
  <IconBase {...props}>
    <path
      d="m5 12.4 4.25 4.05L19.4 6.8"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
    />
  </IconBase>
);

export const CloseIcon = (props: IconProps) => (
  <IconBase {...props}>
    <path
      d="m6.4 6.4 11.2 11.2M17.6 6.4 6.4 17.6"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="1.8"
    />
  </IconBase>
);

export const MenuIcon = (props: IconProps) => (
  <IconBase {...props}>
    <path
      d="M4 6.8c4.4-.2 9.6-.1 16 0M4 12c5.5-.1 10.4 0 16 0M4 17.2c3.9.15 8.8.1 12.5 0"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="1.8"
    />
  </IconBase>
);

export const ChevronIcon = (props: IconProps) => (
  <IconBase {...props}>
    <path
      d="m6.2 9.4 5.7 5.5 5.9-5.6"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
    />
  </IconBase>
);

export const PlusIcon = (props: IconProps) => (
  <IconBase {...props}>
    <path
      d="M12.05 5.5c-.05 4.3-.05 8.7 0 13M5.5 12.05c4.3-.1 8.7-.05 13-.05"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="1.8"
    />
  </IconBase>
);

export const MinusIcon = (props: IconProps) => (
  <IconBase {...props}>
    <path
      d="M5.4 12.1c4.4-.2 8.9-.15 13.2-.1"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="2"
    />
  </IconBase>
);

export const InfoIcon = (props: IconProps) => (
  <IconBase {...props}>
    <circle cx="12" cy="12" r="9.2" stroke="currentColor" strokeWidth="1.65" />
    <path
      d="M12 10.8c.05 2.1.05 4.2 0 6.3"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="1.8"
    />
    <path
      d="M11.95 7.2h.1"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="2.2"
    />
  </IconBase>
);

export const WarningIcon = (props: IconProps) => (
  <IconBase {...props}>
    <path
      d="M11.1 3.9 2.9 18.3c-.5.9.1 2 1.15 2h15.9c1.05 0 1.65-1.1 1.15-2L12.9 3.9a1.03 1.03 0 0 0-1.8 0Z"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.65"
    />
    <path
      d="M12 9.4c.05 1.75.05 3.5 0 5.2"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="1.8"
    />
    <path
      d="M11.95 17.6h.1"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="2.2"
    />
  </IconBase>
);

export const CalendarIcon = (props: IconProps) => (
  <IconBase {...props}>
    <rect
      height="15"
      rx="3"
      stroke="currentColor"
      strokeWidth="1.65"
      width="16.7"
      x="3.7"
      y="5.3"
    />
    <path
      d="M8.1 3.4v3.1M15.9 3.5v3"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="1.7"
    />
    <path
      d="M4.3 9.9c5.3-.15 10.2-.1 15.4 0"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="1.65"
    />
  </IconBase>
);

export const ChevronsUpDownIcon = (props: IconProps) => (
  <IconBase {...props}>
    <path
      d="m8.2 9.3 3.8-3.7 3.9 3.6M8.2 14.7l3.8 3.8 3.9-3.7"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
    />
  </IconBase>
);

export const SearchIcon = (props: IconProps) => (
  <IconBase {...props}>
    <circle cx="10.8" cy="10.6" r="6.3" stroke="currentColor" strokeWidth="1.7" />
    <path
      d="M15.4 15.5c1.9 1.75 3.6 3.4 5.1 5"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="1.8"
    />
  </IconBase>
);

export interface StarIconProps extends IconProps {
  /** Fills the star with currentColor for selected/active states. */
  filled?: boolean;
}

export const StarIcon = ({ filled = false, ...props }: StarIconProps) => (
  <IconBase {...props}>
    <path
      d="M12 3.4l2.55 5.3 5.75.75-4.2 4.05 1.05 5.7L12 16.5l-5.2 2.7 1.1-5.7-4.25-4.1 5.8-.7L12 3.4Z"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.65"
    />
  </IconBase>
);

export const GripIcon = (props: IconProps) => (
  <IconBase {...props}>
    <path
      d="M9.4 6.6h.1M9.45 12h.1M9.4 17.4h.1M14.6 6.65h.1M14.55 12.05h.1M14.6 17.35h.1"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="2.2"
    />
  </IconBase>
);

export const FileIcon = (props: IconProps) => (
  <IconBase {...props}>
    <path
      d="M14 3.2H7.1c-.6 0-1.1.5-1.1 1.1v15.3c0 .6.5 1.1 1.1 1.1h9.8c.6 0 1.1-.5 1.1-1.1V7.3L14 3.2Z"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.65"
    />
    <path
      d="M13.9 3.4c.05 1.5.05 2.7.1 3.8 1.3.1 2.6.1 3.9.05"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="1.65"
    />
  </IconBase>
);

export const FolderIcon = (props: IconProps) => (
  <IconBase {...props}>
    <path
      d="M3.4 6.5c0-.6.5-1.1 1.1-1.1h4.1c.35 0 .68.16.88.44l1.42 1.96h7.6c.6 0 1.1.5 1.1 1.1v9.5c0 .6-.5 1.1-1.1 1.1H4.5c-.6 0-1.1-.5-1.1-1.1V6.5Z"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.65"
    />
  </IconBase>
);

export const GithubIcon = (props: IconProps) => (
  <IconBase {...props}>
    <path
      d="M12 .3a12 12 0 0 0-3.8 23.39c.6.1.82-.26.82-.58v-2.17c-3.34.72-4.04-1.61-4.04-1.61-.55-1.38-1.33-1.75-1.33-1.75-1.09-.74.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.82 2.8 1.3 3.49.99.11-.77.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.63-5.49 5.92.43.37.81 1.1.81 2.22v3.29c0 .32.22.69.83.58A12 12 0 0 0 12 .3Z"
      fill="currentColor"
    />
  </IconBase>
);

export const ScribbleArrow = ({ className }: { className?: string }) => (
  <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 104 60">
    <path
      d="M5 14c22-8 45-5 58 5 12 9 10 22-1 28-8 4-20 1-17-8 4-11 27-13 48-6"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="2"
    />
    <path
      d="m86 26 9 7-10 5"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
    />
  </svg>
);
