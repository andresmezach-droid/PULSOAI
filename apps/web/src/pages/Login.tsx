import React, { useState } from 'react';
import { Lock, Mail, ShieldCheck } from 'lucide-react';
import { supabase } from '../lib/supabase';

export const Login: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErrorMsg(null);
    setIsLoading(true);

    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (error) {
        setErrorMsg(error.message);
      }
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Error inesperado al iniciar sesión'
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0F172A] flex flex-col justify-center items-center px-4">
      <div className="w-full max-w-md bg-white border border-slate-200 rounded-xl shadow-2xl overflow-hidden">
        {/* Encabezado con Logotipo Oficial PULSO AI */}
        <div className="bg-white px-8 pt-8 pb-5 border-b border-slate-100 flex flex-col items-center text-center">
          <div className="flex items-center justify-center gap-3 mb-2">
            <img
              src="/favicon.jpg"
              alt="PULSO AI Isotipo"
              className="w-12 h-12 rounded-xl object-contain"
            />
            <img
              src="/pulso-wordmark.jpg"
              alt="PULSO AI — Smart Medical Scheduling"
              className="h-12 object-contain"
            />
          </div>
          <p className="text-xs font-medium text-slate-500">
            Automatización de WhatsApp & Agenda Médica Multi-Tenant
          </p>
        </div>

        {/* Formulario */}
        <form onSubmit={handleSubmit} className="p-8 space-y-5">
          <div>
            <h1 className="text-lg font-bold text-[#0F172A]">
              Acceso al Panel de Clínica
            </h1>
            <p className="text-xs text-slate-500 mt-1">
              Ingresa con tus credenciales autorizadas en Supabase Auth.
            </p>
          </div>

          {errorMsg && (
            <div className="p-3.5 rounded-lg bg-red-50 border border-red-200 text-xs font-medium text-red-700">
              {errorMsg}
            </div>
          )}

          <div className="space-y-1.5">
            <label
              htmlFor="email"
              className="block text-xs font-semibold uppercase tracking-wider text-slate-700"
            >
              Correo Electrónico
            </label>
            <div className="relative">
              <Mail className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                id="email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="recepcion@clinica.com"
                className="w-full pl-10 pr-4 py-2.5 text-sm bg-[#F8FAFC] border border-slate-300 rounded-lg text-[#0F172A] focus:outline-none focus:ring-2 focus:ring-[#06B6D4] focus:border-transparent"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="password"
              className="block text-xs font-semibold uppercase tracking-wider text-slate-700"
            >
              Contraseña
            </label>
            <div className="relative">
              <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                id="password"
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full pl-10 pr-4 py-2.5 text-sm bg-[#F8FAFC] border border-slate-300 rounded-lg text-[#0F172A] focus:outline-none focus:ring-2 focus:ring-[#06B6D4] focus:border-transparent"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="w-full py-2.5 px-4 rounded-lg bg-[#0F172A] hover:bg-slate-800 text-white font-semibold text-sm transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {isLoading ? 'Verificando acceso...' : 'Iniciar Sesión'}
          </button>

          <div className="pt-3 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-500">
            <span className="flex items-center gap-1.5 font-medium">
              <ShieldCheck className="w-3.5 h-3.5 text-[#10B981]" />
              Aislamiento Multi-Tenant RLS Activo
            </span>
            <span>Venezuela (America/Caracas)</span>
          </div>
        </form>
      </div>
    </div>
  );
};
