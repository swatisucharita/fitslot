import Link from "next/link";

export function Shell({ subtitle, children }: { subtitle: string; children: React.ReactNode }) {
  return (
    <>
      <header>
        <Link href="/">FitSlot</Link>
        <span>{subtitle}</span>
      </header>
      <main>{children}</main>
    </>
  );
}
