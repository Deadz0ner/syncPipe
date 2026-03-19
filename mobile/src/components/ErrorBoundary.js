/**
 * ErrorBoundary - Catches unhandled errors in the app and shows recovery UI
 * Prevents fatal crashes from completely breaking the app
 */

import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { COLORS } from '../theme/colors';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true };
  }

  componentDidCatch(error, errorInfo) {
    console.error('[ErrorBoundary] Caught error:', error);
    console.error('[ErrorBoundary] Error info:', errorInfo);
    this.setState({
      error,
      errorInfo,
    });
  }

  handleReset = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
  };

  render() {
    if (this.state.hasError) {
      return (
        <View style={styles.container}>
          <View style={styles.contentContainer}>
            <Text style={styles.title}>Oops! Something went wrong</Text>
            <Text style={styles.subtitle}>
              The app encountered an unexpected error. Please try again.
            </Text>
            {__DEV__ && this.state.error && (
              <>
                <Text style={styles.errorTitle}>Error Details (Dev Only):</Text>
                <Text style={styles.errorText}>{this.state.error.toString()}</Text>
                {this.state.errorInfo && (
                  <Text style={styles.stackTrace}>
                    {this.state.errorInfo.componentStack}
                  </Text>
                )}
              </>
            )}
            <TouchableOpacity
              style={styles.resetButton}
              onPress={this.handleReset}
            >
              <Text style={styles.resetButtonText}>Try Again</Text>
            </TouchableOpacity>
          </View>
        </View>
      );
    }

    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background.primary,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  contentContainer: {
    alignItems: 'center',
    maxWidth: 320,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: COLORS.text.primary,
    marginBottom: 12,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 16,
    color: COLORS.text.secondary,
    marginBottom: 24,
    textAlign: 'center',
    lineHeight: 24,
  },
  errorTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.accent.red,
    marginTop: 16,
    marginBottom: 8,
    textTransform: 'uppercase',
  },
  errorText: {
    fontSize: 12,
    color: COLORS.text.tertiary,
    fontFamily: 'monospace',
    backgroundColor: COLORS.background.surface,
    padding: 12,
    borderRadius: 6,
    marginBottom: 8,
    maxHeight: 100,
  },
  stackTrace: {
    fontSize: 10,
    color: COLORS.text.tertiary,
    fontFamily: 'monospace',
    backgroundColor: COLORS.background.surface,
    padding: 12,
    borderRadius: 6,
    maxHeight: 150,
    marginBottom: 16,
  },
  resetButton: {
    backgroundColor: COLORS.accent.green,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 6,
    marginTop: 16,
  },
  resetButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
});

export default ErrorBoundary;
