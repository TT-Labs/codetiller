import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Icon({ size = 16, children, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  )
}

export const ArrowRight = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.5 8h10M8.5 4l4 4-4 4" />
  </Icon>
)
export const ArrowUpRight = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.5 11.5l7-7M5.5 4.5h6v6" />
  </Icon>
)
export const Check = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 8.5l3.2 3.2L13 4.8" />
  </Icon>
)
export const Copy = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5.5 5.5v-3h8v8h-3M2.5 5.5h8v8h-8z" />
  </Icon>
)
export const Menu = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2 5h12M2 11h12" />
  </Icon>
)
export const Close = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
  </Icon>
)
export const Search = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="7" cy="7" r="4.25" />
    <path d="M10.2 10.2l3.3 3.3" />
  </Icon>
)
export const Sun = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="2.75" />
    <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M12.6 3.4l-1 1M4.4 11.6l-1 1" />
  </Icon>
)
export const Moon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8z" strokeLinejoin="round" />
  </Icon>
)
export const Monitor = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2 3h12v8H2zM5.5 13.5h5" />
  </Icon>
)
export const Plus = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 3v10M3 8h10" />
  </Icon>
)
export const Pause = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5.5 3.5v9M10.5 3.5v9" />
  </Icon>
)
export const Play = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 3.5l7 4.5-7 4.5z" />
  </Icon>
)
export const Github = ({ size = 16, ...p }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="currentColor"
    aria-hidden="true"
    focusable="false"
    {...p}
  >
    <path d="M8 .2a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.36-.93-.89-1.17-.89-1.17-.73-.5.05-.49.05-.49.8.06 1.23.83 1.23.83.72 1.22 1.88.87 2.33.66.07-.52.28-.87.5-1.07-1.77-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.03 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.19c0 .21.15.46.55.38A8 8 0 0 0 8 .2z" />
  </svg>
)
