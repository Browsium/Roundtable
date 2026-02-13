'use client';

import styles from './HourglassSpinner.module.css';

type HourglassSpinnerProps = {
  className?: string;
  title?: string;
};

export default function HourglassSpinner({ className = '', title }: HourglassSpinnerProps) {
  const ariaLabel = title || 'Processing';

  return (
    <span className={`${styles.root} ${className}`} aria-hidden={title ? undefined : true} title={title}>
      <svg
        className={styles.svg}
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        role={title ? 'img' : 'presentation'}
        aria-label={title ? ariaLabel : undefined}
      >
        {/* Outline */}
        <path
          d="M7 2h10v4l-4 4v4l4 4v4H7v-4l4-4v-4L7 6V2z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />

        {/* Sand (top drains, bottom fills) */}
        <polygon
          className={styles.sandTop}
          points="8.5,6.5 15.5,6.5 12,10"
          fill="currentColor"
        />
        <polygon
          className={styles.sandBottom}
          points="12,14 8.5,17.5 15.5,17.5"
          fill="currentColor"
        />

        {/* Sand stream */}
        <rect
          className={styles.stream}
          x="11.5"
          y="10.2"
          width="1"
          height="3.6"
          rx="0.5"
          fill="currentColor"
        />
      </svg>
    </span>
  );
}

