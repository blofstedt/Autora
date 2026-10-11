import { IconStore } from "../Icons";

/** Where people will make tools and put them for others. Not built yet. */
export function StorePage() {
  return (
    <div className="page-scroll">
      <div className="page-inner">
        <div className="nb-empty">
          <IconStore size={28} />
          <p>Coming soon.</p>
          <p className="jf-hint">The Store will be where you make tools and share them.</p>
        </div>
      </div>
    </div>
  );
}
