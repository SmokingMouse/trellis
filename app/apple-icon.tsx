import { ImageResponse } from "next/og";

// iOS home-screen icon. iOS auto-rounds the corners, so we ship a
// full-bleed gradient instead of the rounded rect baked into icon.svg.
// 180×180 is the modern Retina apple-touch-icon size.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          background:
            "linear-gradient(135deg, #6366f1 0%, #d946ef 50%, #fbbf24 100%)",
        }}
      >
        <svg
          viewBox="0 0 512 512"
          xmlns="http://www.w3.org/2000/svg"
          width="100%"
          height="100%"
        >
          <g
            stroke="white"
            strokeWidth="32"
            strokeLinecap="round"
            fill="white"
          >
            <line x1="256" y1="170" x2="170" y2="340" />
            <line x1="256" y1="170" x2="342" y2="340" />
            <circle cx="256" cy="170" r="60" />
            <circle cx="170" cy="340" r="60" />
            <circle cx="342" cy="340" r="60" />
          </g>
        </svg>
      </div>
    ),
    { ...size },
  );
}
