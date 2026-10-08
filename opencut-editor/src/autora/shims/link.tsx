import type { AnchorHTMLAttributes } from "react";

/** next/link, as a plain anchor: the editor has no pages to move between. */
export default function Link({
  href,
  prefetch: _prefetch,
  replace: _replace,
  scroll: _scroll,
  ...rest
}: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: string | { pathname?: string };
  prefetch?: boolean;
  replace?: boolean;
  scroll?: boolean;
}) {
  return <a href={typeof href === "string" ? href : (href.pathname ?? "#")} {...rest} />;
}
