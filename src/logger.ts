export enum LogLevel {
  INFO = "INFO",
  WARN = "WARN",
  ERROR = "ERROR",
  DEBUG = "DEBUG",
}

class Logger {
  private format(level: LogLevel, message: string, context?: string) {
    const timestamp = new Date().toISOString();
    const ctx = context ? `[${context}] ` : "";
    return `[${timestamp}] [${level}] ${ctx}${message}`;
  }

  info(message: string, context?: string) {
    console.log(this.format(LogLevel.INFO, message, context));
  }

  warn(message: string, context?: string) {
    console.warn(this.format(LogLevel.WARN, message, context));
  }

  error(message: string, context?: string, error?: unknown) {
    console.error(
      this.format(LogLevel.ERROR, message, context),
      (error as Error)?.message || error || "",
    );
  }

  debug(message: string, context?: string) {
    console.debug(this.format(LogLevel.DEBUG, message, context));
  }
}

export const logger = new Logger();
