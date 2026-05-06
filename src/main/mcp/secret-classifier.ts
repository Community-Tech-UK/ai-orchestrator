export class SecretClassifier {
  private readonly secretKeyPattern = /(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|AUTH|BEARER|COOKIE|SESSION|CREDENTIAL)/i;
  private readonly jwtPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
  private readonly longHexPattern = /^[a-f0-9]{32,}$/i;
  private readonly longBase64LikePattern = /^[A-Za-z0-9_+/=-]{40,}$/;

  isSecret(key: string, value: string): boolean {
    if (this.secretKeyPattern.test(key)) {
      return true;
    }
    if (this.jwtPattern.test(value)) {
      return true;
    }
    if (this.longHexPattern.test(value)) {
      return true;
    }
    return this.longBase64LikePattern.test(value) && /[A-Z]/.test(value) && /[a-z]/.test(value);
  }
}
