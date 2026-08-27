import { Component } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

/**
 * Catches render-time crashes so a single broken component shows a recoverable
 * message instead of a blank white page with the error only in the console.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Unhandled UI error:', error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <div className="w-full max-w-md rounded-xl border border-border bg-card p-8 text-center shadow-sm">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[#E46E78]/10">
            <AlertTriangle className="h-6 w-6 text-[#E46E78]" />
          </div>
          <h1 className="text-lg font-semibold text-foreground">Something went wrong</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            The page hit an unexpected error. Reloading usually clears it.
          </p>
          {import.meta.env.DEV && (
            <pre className="mt-4 max-h-40 overflow-auto rounded-md bg-muted p-3 text-left text-xs text-muted-foreground">
              {this.state.error?.message}
            </pre>
          )}
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-6 inline-flex items-center gap-2 rounded-lg bg-[#714B67] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#5A3C52]"
          >
            <RotateCcw className="h-4 w-4" />
            Reload page
          </button>
        </div>
      </div>
    );
  }
}
