import { FastifyBaseLogger } from 'fastify';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';

import StreamSocket, { MediaBaseAudioMessage } from '@/services/StreamSocket';
import { Config } from '@/config';

type AudioInterceptorOptions = {
  logger: FastifyBaseLogger;
  config: Config;
  callerLanguage: string;
};
export default class AudioInterceptor {
  private static instance: AudioInterceptor;

  private readonly logger: FastifyBaseLogger;

  private config: Config;

  private callerLanguage: string | undefined;

  #inboundSocket?: StreamSocket;

  #outboundSocket?: StreamSocket;

  #callerOpenAISocket?: WebSocket;

  #agentOpenAISocket?: WebSocket;

  #agentFirstAudioTime?: string;

  #callerMessages?: Object[];

  #agentMessages?: Object[];

  public constructor(options: AudioInterceptorOptions) {
    this.logger = options.logger;
    this.config = options.config;
    this.callerLanguage = options.callerLanguage;
    this.setupOpenAISockets();
  }

  public close() {
    if (this.#inboundSocket) {
      this.#inboundSocket.close();
      this.#inboundSocket = null;
    }
    if (this.#outboundSocket) {
      this.#outboundSocket.close();
      this.#outboundSocket = null;
    }
    if (this.#callerOpenAISocket) {
      this.#callerOpenAISocket.close();
    }
    if (this.#agentOpenAISocket) {
      this.#agentOpenAISocket.close();
    }
    const callerAverageTimeToFirstAudioBufferAdd = this.reportOnSocketTimeToFirstAudioBufferAdd(this.#callerMessages);
    this.logger.info(`callerAverageTimeToFirstAudioBufferAdd = ${callerAverageTimeToFirstAudioBufferAdd}`);
    const agentAverageTimeToFirstAudioBufferAdd = this.reportOnSocketTimeToFirstAudioBufferAdd(this.#agentMessages);
    this.logger.info(`agentAverageTimeToFirstAudioBufferAdd = ${agentAverageTimeToFirstAudioBufferAdd}`);
    const combinedAverageTimeToFirstAudioBufferAdd = (callerAverageTimeToFirstAudioBufferAdd + agentAverageTimeToFirstAudioBufferAdd) / 2;
    this.logger.info(`combinedAverageTimeToFirstAudioBufferAdd = ${combinedAverageTimeToFirstAudioBufferAdd}`);
  }

  public start() {
    if (!this.#outboundSocket || !this.#inboundSocket) {
      this.logger.error('Both sockets are not set. Cannot start interception');
      return;
    }

    this.logger.info('Initiating the websocket to OpenAI Realtime S2S API');
    // Start Audio Interception
    this.logger.info('Both sockets are set. Starting interception');
    this.#inboundSocket.onMedia(
      this.translateAndForwardAudioToOutbound.bind(this),
    );
    this.#outboundSocket.onMedia(
      this.translateAndForwardAudioToInbound.bind(this),
    );
  }

  private translateAndForwardAudioToInbound(message: MediaBaseAudioMessage) {
    // Wait for 1 second after the first time we hear audio from the agent
    // This ensures that we don't send beeps from Flex to OpenAI when the call
    // first connects
    const currentTime = new Date().getTime();
    if (!this.#agentFirstAudioTime) {
      this.#agentFirstAudioTime = currentTime;
    } else if (currentTime - this.#agentFirstAudioTime >= 1000) {
      if (this.#agentOpenAISocket) {
        this.forwardAudioToOpenAIForTranslation(this.#agentOpenAISocket, message.media.payload);
      } else {
        this.logger.error('Agent OpenAI WebSocket is not available.');
      }
    }
  }

  private translateAndForwardAudioToOutbound(message: MediaBaseAudioMessage) {
    if (this.#callerOpenAISocket) {
      this.forwardAudioToOpenAIForTranslation(this.#callerOpenAISocket, message.media.payload);
    } else {
      this.logger.error('Caller OpenAI WebSocket is not available.');
    }
  }

  /**
   * Setup the WebSocket connection to OpenAI Realtime S2S API
   * @private
   */
  private setupOpenAISockets() {
    const url = 'wss://api.openai.com/v1/realtime';
    const callerSocket = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${this.config.OPENAI_API_KEY}`,
      },
    });
    const agentSocket = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${this.config.OPENAI_API_KEY}`,
      },
    });
    const callerPrompt = this.config.AI_PROMPT_CALLER.replace(
      /\[CALLER_LANGUAGE\]/g,
      this.callerLanguage,
    );
    const agentPrompt = this.config.AI_PROMPT_AGENT.replace(
      /\[CALLER_LANGUAGE\]/g,
      this.callerLanguage,
    );

    // Store the WebSocket instances
    this.#callerOpenAISocket = callerSocket;
    this.#agentOpenAISocket = agentSocket;

    // Configure the Realtime AI Agents
    const callerConfigMsg = {
      event: 'set_inference_config',
      system_message: callerPrompt,
      turn_end_type: 'server_detection',
      voice: 'alloy',
      tool_choice: 'none',
      disable_audio: false,
      audio_format: 'g711-ulaw',
    };
    const agentConfigMsg = {
      event: 'set_inference_config',
      system_message: agentPrompt,
      turn_end_type: 'server_detection',
      voice: 'alloy',
      tool_choice: 'none',
      disable_audio: false,
      audio_format: 'g711-ulaw',
    };

    // Event listeners for when the connection is opened
    callerSocket.on('open', () => {
      this.logger.info('Caller webSocket connection to OpenAI is open now.');
      // Send the initial prompt/config message to OpenAI for the Translation Agent.
      this.sendMessageToOpenAI(callerSocket, callerConfigMsg);
      this.logger.info(
        callerConfigMsg,
        'Caller session has been configured with the following settings:',
      );
    });
    agentSocket.on('open', () => {
      this.logger.info('Agent webSocket connection to OpenAI is open now.');
      // Send the initial prompt/config message to OpenAI for the Translation Agent.
      this.sendMessageToOpenAI(agentSocket, agentConfigMsg);
      this.logger.info(
        agentConfigMsg,
        'Agent session has been configured with the following settings:',
      );
    });

    // Event listeners for when a message is received from the server
    callerSocket.on('message', (message) => {
      this.logger.info(`Caller message from OpenAI: ${message}`);
      const currentTime = new Date().getTime();
      const messageObject = JSON.parse(message);
      if (messageObject.event === 'vad_speech_stopped') {
        if (!this.#callerMessages) {
          this.#callerMessages = [];
        }
        this.#callerMessages.push({
          message_id: messageObject.message_id,
          vad_speech_stopped_time: currentTime
        });
      }
      if (messageObject.event === 'audio_buffer_add') {
        // Handle an audio message from OpenAI, post translation
        this.logger.info('Received caller translation from OpenAI');
        if (!this.#callerMessages[this.#callerMessages.length - 1].first_audio_buffer_add_time) {
          this.#callerMessages[this.#callerMessages.length - 1].first_audio_buffer_add_time = currentTime;
        }
        this.#outboundSocket.send([messageObject.data]);
      }
    });
    agentSocket.on('message', (message) => {
      this.logger.info(`Agent message from OpenAI: ${message.toString()}`);
      const currentTime = new Date().getTime();
      const messageObject = JSON.parse(message);
      if (messageObject.event === 'vad_speech_stopped') {
        if (!this.#agentMessages) {
          this.#agentMessages = [];
        }
        this.#agentMessages.push({
          message_id: messageObject.message_id,
          vad_speech_stopped_time: currentTime
        });
      }
      if (messageObject.event === 'audio_buffer_add') {
        // Handle an audio message from OpenAI, post translation
        this.logger.info('Received agent translation from OpenAI');
        if (!this.#agentMessages[this.#agentMessages.length - 1].first_audio_buffer_add_time) {
          this.#agentMessages[this.#agentMessages.length - 1].first_audio_buffer_add_time = currentTime;
        }
        this.#inboundSocket.send([messageObject.data]);
      }
    });

    // Event listeners for when an error occurs
    callerSocket.on('error', (error) => {
      this.logger.error('Caller webSocket error:', error);
    });
    agentSocket.on('error', (error) => {
      this.logger.error('Agent webSocket error:', error);
    });

    // Event listeners for when the connection is closed
    callerSocket.on('close', () => {
      this.logger.info('Caller webSocket connection to OpenAI is closed now.');
    });

    agentSocket.on('close', () => {
      this.logger.info('Agent webSocket connection to OpenAI is closed now.');
    });
  }

  private reportOnSocketTimeToFirstAudioBufferAdd(messages: Object[]) {
    let numMessagesWithAudioBufferAdd = 0;
    let totalTimeToFirstAudioBufferAdd = 0;
    messages.forEach((message) => {
      // Only report on messages that have an associated audio_buffer_add
      if (message.first_audio_buffer_add_time) {
        numMessagesWithAudioBufferAdd++;
        const timeToFirstAudioBufferAdd = message.first_audio_buffer_add_time - message.vad_speech_stopped_time;
        this.logger.info(`Message ${message.message_id} timeToFirstAudioBufferAdd = ${timeToFirstAudioBufferAdd}`);
        totalTimeToFirstAudioBufferAdd = totalTimeToFirstAudioBufferAdd + timeToFirstAudioBufferAdd;
      }
    });
    const averageTimeToFirstAudioBufferAdd = totalTimeToFirstAudioBufferAdd / numMessagesWithAudioBufferAdd;
    return averageTimeToFirstAudioBufferAdd;
  }

  private forwardAudioToOpenAIForTranslation(socket: WebSocket, audio: String) {
    this.sendMessageToOpenAI(socket, {
      event: 'audio_buffer_add',
      data: audio,
    });
  }

  private sendMessageToOpenAI(socket: WebSocket, message: object) {
    if (socket.readyState === WebSocket.OPEN) {
      const jsonMessage = JSON.stringify(message);
      socket.send(jsonMessage);
    } else {
      this.logger.error('WebSocket is not open. Unable to send message.');
    }
  }

  get inboundSocket(): StreamSocket {
    if (!this.#inboundSocket) {
      throw new Error('Inbound socket not set');
    }
    return this.#inboundSocket;
  }

  set inboundSocket(value: StreamSocket) {
    this.#inboundSocket = value;
  }

  get outboundSocket(): StreamSocket {
    if (!this.#outboundSocket) {
      throw new Error('Outbound socket not set');
    }
    return this.#outboundSocket;
  }

  set outboundSocket(value: StreamSocket) {
    this.#outboundSocket = value;
  }
}
