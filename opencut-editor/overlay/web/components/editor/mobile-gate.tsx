import type { ReactNode } from "react";

/** OpenCut asks phone visitors to confirm; Autora's window already decides its own size. */
export function MobileGate({ children }: { children: ReactNode }) {
	return <>{children}</>;
}
