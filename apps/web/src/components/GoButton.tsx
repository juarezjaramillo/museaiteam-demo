/** A button that goes to a URL.
 *
 * A <button> nested inside an <a> silently eats the click in every
 * browser (the inner control wins, the link never fires), so this is
 * the only way to make a button-shaped link: a real button that moves
 * the page itself. Use this instead of hand-writing <a><button>.
 */
export function GoButton({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        window.location.assign(href);
      }}
    >
      {children}
    </button>
  );
}
