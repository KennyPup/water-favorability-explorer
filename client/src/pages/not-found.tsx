export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background text-foreground">
      <div className="text-center">
        <h1 className="text-4xl font-bold text-muted-foreground mb-2">404</h1>
        <p className="text-sm text-muted-foreground">Page not found</p>
        <a href="#/" className="mt-4 inline-block text-primary hover:underline text-sm">
          ← Back to HF Explorer
        </a>
      </div>
    </div>
  );
}
