'use client';

import styles from './ScannerBar.module.css';

type ScannerBarProps = {
  className?: string;
  title?: string;
};

export default function ScannerBar({ className = '', title }: ScannerBarProps) {
  return (
    <div
      className={`${styles.track} ${className}`}
      aria-hidden={title ? undefined : true}
      title={title}
    >
      <div className={styles.eye} />
    </div>
  );
}

