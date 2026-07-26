/**
 * Pulls in the jest-dom matcher types (toBeInTheDocument, toHaveAttribute, …) that
 * `vitest-setup.ts` registers at runtime, so type checking sees them too.
 */
import '@testing-library/jest-dom/vitest';
