import { useState } from 'react';
import { resolveAppUrl } from '../utils/authFetch';

interface QuoteFreightParams {
  orderId: string;
  storeId: string;
}

interface QuoteFreightResponse {
  success: boolean;
  orderId: string;
  orderNumber: string;
  freight: {
    paid: number;
    quoted: number;
    difference: number;
    percentDifference: string;
  };
  options: {
    cheapest: any;
    fastest: any;
    all: any[];
  };
}

export const useFreightQuote = () => {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const quoteFreight = async (params: QuoteFreightParams): Promise<QuoteFreightResponse> => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(resolveAppUrl(`/api/freight/quote/${params.orderId}`), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          storeId: params.storeId
        })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.details || data.error || 'Erro ao cotar frete');
      }

      return data;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Erro desconhecido';
      setError(errorMessage);
      throw err;
    } finally {
      setIsLoading(false);
    }
  };

  return {
    quoteFreight,
    isLoading,
    error
  };
};
