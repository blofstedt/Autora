// @flow
import * as React from 'react';

/**
 * GDevelop's AI is not part of Autora's editor: Autora is what helps, from outside, on the
 * same game. The rest of the editor still asks this context whether an AI request is working
 * (it never is), so the context stays, empty, and its provider does nothing.
 */
const noop = () => {};
const asyncNoop = async () => {};

export const initialAiRequestContextState: any = {
  aiRequestStorage: {
    fetchAiRequestSummaries: asyncNoop,
    aiRequestSummaries: {},
    aiRequests: {},
    isLoading: false,
    error: null,
  },
  getAiSettings: () => null,
  getWorkingAiRequest: () => null,
  suspendAiRequest: asyncNoop,
  selectedAiRequestId: null,
  setSelectedAiRequestId: noop,
  selectedAiRequest: null,
};

export const AiRequestContext: React.Context<any> = React.createContext<any>(
  initialAiRequestContextState
);

export const AiRequestProvider = ({
  children,
}: {|
  children: React.Node,
|}): React.Node => children;
