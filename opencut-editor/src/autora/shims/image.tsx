import type { CSSProperties, ImgHTMLAttributes } from "react";

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  src: string | { src: string };
  fill?: boolean;
  priority?: boolean;
  unoptimized?: boolean;
  quality?: number;
  placeholder?: string;
  blurDataURL?: string;
  loader?: unknown;
};

/** next/image, as an <img>: nothing here is resized by a server. */
export default function Image({ src, fill, priority: _p, unoptimized: _u, quality: _q, placeholder: _ph, blurDataURL: _b, loader: _l, style, alt, ...rest }: Props) {
  const filled: CSSProperties | undefined = fill
    ? { position: "absolute", inset: 0, width: "100%", height: "100%", ...style }
    : style;
  return <img src={typeof src === "string" ? src : src.src} alt={alt ?? ""} style={filled} {...rest} />;
}
