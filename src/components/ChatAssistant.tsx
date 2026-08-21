import React, { useState, useRef, useEffect } from 'react';
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '../../amplify/data/resource';

const client = generateClient<Schema>();

type Message = {
  id: string;
  role: 'user' | 'agent';
  text: string;
};

interface ChatAssistantProps {
  onDraftAccepted: (draft: string) => void;
}

export default function ChatAssistant({ onDraftAccepted }: ChatAssistantProps) {
  const [messages, setMessages] = useState<Message[]>([
    { id: '1', role: 'agent', text: 'Hello! I am your AWS AgentCore assistant. Need help drafting or translating a 140-character campaign message?' }
  ]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isTyping) return;

    const userMsg: Message = { id: Date.now().toString(), role: 'user', text: input.trim() };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setIsTyping(true);

    try {
      // NOTE: chatWithCampaignAgent mutation is commented out in the schema
      // until the chatAgent Lambda function is implemented.
      // For now, we provide a mock response.
      
      const mockResponse = `I've reviewed your message: "${userMsg.text}". This is a placeholder response until the AgentCore Lambda is deployed.`;
      
      const agentMsg: Message = { 
        id: (Date.now() + 1).toString(), 
        role: 'agent', 
        text: mockResponse
      };
      
      setMessages((prev) => [...prev, agentMsg]);
    } catch (error) {
      console.error("Agent Error:", error);
      setMessages((prev) => [...prev, { 
        id: Date.now().toString(), 
        role: 'agent', 
        text: '⚠️ Communication with the AWS AgentCore failed. Please check your console.' 
      }]);
    } finally {
      setIsTyping(false);
    }
  };

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <h4>AgentCore Assistant</h4>
      </div>
      
      <div className="chat-history" ref={scrollRef}>
        {messages.map((msg) => (
          <div key={msg.id} className={`chat-bubble-container ${msg.role}`}>
            <div className={`chat-bubble ${msg.role}`}>
              {msg.text}
            </div>
            {/* If the agent provides a draft, let the admin click it to populate the main form */}
            {msg.role === 'agent' && msg.id !== '1' && (
              <button 
                className="btn-use-draft" 
                onClick={() => onDraftAccepted(msg.text)}
              >
                Use this draft ➔
              </button>
            )}
          </div>
        ))}
        {isTyping && (
          <div className="chat-bubble-container agent">
            <div className="chat-bubble agent typing-indicator">
              <span>.</span><span>.</span><span>.</span>
            </div>
          </div>
        )}
      </div>

      <form className="chat-input-area" onSubmit={handleSend}>
        <input 
          type="text" 
          placeholder="Ask the AI to draft a message..." 
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={isTyping}
        />
        <button type="submit" disabled={!input.trim() || isTyping}>
          Send
        </button>
      </form>
    </div>
  );
}
