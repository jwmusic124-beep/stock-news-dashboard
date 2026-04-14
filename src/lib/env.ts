export const env = {
  finnhubKey(): string {
    return (
      process.env.FINNHUB_KEY?.trim() ||
      process.env.FINNHUB_API_KEY?.trim() ||
      ""
    );
  },
  twelveDataKey(): string {
    return (
      process.env.TWELVE_DATA_KEY?.trim() ||
      process.env.TWELVEDATA_KEY?.trim() ||
      ""
    );
  },
  groqApiKey(): string {
    return process.env.GROQ_API_KEY?.trim() ?? "";
  },
};
