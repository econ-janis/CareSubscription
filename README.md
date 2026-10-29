# CareSubscription

Notificaciones programadas de información de clientes de Janis Commerce a las áreas que corresponda.
El repo está organizado en **módulos** (apartados); cada uno tiene su configuración, plantilla y programación, y reutiliza la parte común: integración con Jira, envío de correo, programación, historial, auditoría y control de destinatarios.

| Módulo | Estado | Descripción |
|---|---|---|
| `ticket-report` | ✅ | Reporte por correo del estado de los tickets de JSM de una Organization (últimos 3 meses): dona por estado, detalle por estado y tickets abiertos. Incluye **envío agrupado**: varias Organizations en un solo correo. |

## Arquitectura

```
public/index.html          UI (acceso con clave, ABM, vista previa, prueba, historial)
api/                       Funciones serverless (Vercel, Node)
  auth.js                  login / logout / sesión
  subscriptions.js         ABM + ?action=preview|test + ?view=history
  organizations.js         Organizations de JSM (cache 24 h) + dominios permitidos por Organization
  dispatch.js              disparado cada hora: envía las suscripciones que tocan
lib/                       Común a todos los módulos
  jira.js                  cliente Jira/JSM con reintentos y paginación
  mailer.js                envío SMTP (AWS SES u otro relay) con reintentos; opcional
  schedule.js              días + hora + zona horaria -> próximo envío
  dispatcher.js / runner.js  ejecución, historial, marca de error y aviso al creador
  recipients.js            validación de correos y dominios permitidos
  logo.js                  descarga y validación de la Logo URL
  auth.js / db.js / http.js / subscriptions.js
  impact/                  Impacto Care: facts.js (métricas por ticket), sync.js (Jira -> Neon), metrics.js (semanas), store.js (tablas)
modules/
  index.js                 registro de módulos
  ticket-report/           JQL, normalización de estados, agregación, dona PNG, plantilla, textos es/pt
config/statuses.json       tabla de estados (alias de Jira, colores, orden, abiertos)
assets/                    logos de Janis en PNG (claro/oscuro) e Inter (OFL) para el gráfico
.github/workflows/dispatch.yml  cron horario que llama a /api/dispatch
```

Stack: Node.js 20+, Vercel (funciones + estáticos) y Neon Postgres, igual que JanisHacks. Las tablas se crean solas en la primera llamada (`schema.sql` queda como referencia).

### Cómo se genera el correo

Los clientes de correo no ejecutan JS y muchos no muestran SVG, así que todo se arma en el servidor:

- El diseño replica el boceto aprobado (`care-weekly-status-carrefour-ar.html`): mismas medidas, colores, tipografía del sistema, bordes de 10 px y formato de números ("13.8%", "100%"). La comparación por captura contra el boceto, con los mismos datos, da diferencias de menos del 1,5 % de los píxeles (anti-aliasing) en escritorio, celular y modo oscuro.
- HTML con tablas y estilos inline (Gmail y Outlook), ancho fluido hasta 1180 px. La columna de la dona mide 360 px y el detalle ocupa el resto. Por debajo de 820 px pasan a una sola columna y las tablas que no entran se desplazan horizontalmente dentro de su tarjeta.
- Modo oscuro con `prefers-color-scheme`, igual que el boceto, con dona y logo del footer en versión oscura (Apple Mail, Outlook app, etc.; Gmail muestra siempre el claro).
- Dona en **PNG** con la geometría del boceto (SVG rasterizado con `@resvg/resvg-js` e Inter embebida), incrustada por **CID**. El logo del cliente y el de Janis también van por CID. Ninguna imagen queda en una URL pública.
- La vista previa de la UI usa la misma plantilla con las imágenes como `data:` URI y no envía nada.
- Los destinatarios van en **CCO**, así ningún destinatario ve las direcciones de los demás (pueden ser de áreas o empresas distintas).

### Programación

Cada envío agrupado define días de la semana, hora y zona horaria (por defecto `America/Santiago`). Las suscripciones no se envían solas. El dispatcher corre cada hora (`.github/workflows/dispatch.yml`, porque el plan Hobby de Vercel solo permite crons diarios). En cada corrida:

1. Calcula el último horario programado que ya pasó y lo envía si todavía no se mandó, siempre que no hayan pasado más de 6 h. Así un cron atrasado se recupera sin mandar envíos viejos.
2. Toma un lock por suscripción para que dos corridas no envíen lo mismo.
3. Ante un fallo transitorio (Jira o SMTP caídos, 429, 5xx) reintenta con backoff dentro de la misma corrida. Si sigue fallando, no marca el envío como hecho, así la corrida de la hora siguiente lo vuelve a intentar.
4. Si Jira rechaza el JQL (por ejemplo, porque renombraron la Organization), la suscripción queda en estado **Error** y se avisa una sola vez por correo a quien la creó. Al guardarla de nuevo con un JQL válido vuelve a **Activa**.

## Módulo `ticket-report`

- **JQL**: es una plantilla. `{organization}` se reemplaza por el nombre de la Organization entre comillas, con escape. Si el JQL no contiene el comodín, la UI muestra una advertencia. Al guardar, el JQL se valida contra Jira (`maxResults=1`) y se muestra el error de Jira si falla. La búsqueda pagina con `POST /rest/api/3/search/jql` (`nextPageToken`) y pide solo `summary`, `status` y `created`.
- **Estados**: se definen en `config/statuses.json` y se pueden ajustar sin tocar código. Los alias se comparan sin distinguir mayúsculas ni tildes. Un estado que no está en la tabla aparece con su nombre original en gris `#9AA3B2`, se registra en los logs y queda como advertencia en el historial.
- **Casos borde**: si no hay tickets, se envía el mensaje "No hay tickets en el período", salvo que la suscripción tenga marcado *No enviar si no hay tickets*. Si no hay tickets abiertos, se muestra "Sin tickets abiertos". Si el logo es inválido, se usa el isotipo de Janis y queda una advertencia.
- **Idioma**: `es` y `pt`.

## Seguridad y privacidad (ISO 27001/27002, GDPR)

- **Acceso**: exclusivamente con **Janis ID** (ver [Ingreso con Janis ID](#ingreso-con-janis-id)). Solo entran cuentas con correo de `USER_DOMAIN`, porque Janis ID también lo usan los clientes. El correo verificado se usa para la auditoría y para "Enviar prueba". La app muestra tickets y destinatarios de clientes, así que nunca queda pública: sin configurar Janis ID no se puede entrar.
- **Destinatarios**: deben tener formato válido y un dominio de la lista permitida, que es `ALLOWED_RECIPIENT_DOMAINS` más los dominios del cliente cargados para esa Organization desde la UI. Se validan al guardar y otra vez en cada envío.
- **Enviar prueba**: se envía solo a quien está configurando.
- **Auditoría**: se registra quién creó, modificó o borró cada suscripción (y los dominios de cada Organization), cuándo y qué campos cambió.
- **Datos**: el historial registra fecha, cantidad de tickets, destinatarios, resultado y error. Para poder ver cada correo enviado ("Ver correo"), guarda además una copia mínima de lo que muestra el correo: totales por estado y, de los tickets abiertos, clave, resumen, estado y responsable. Esa copia se borra sola a los 90 días; la fila del historial queda.
- **Logo URL**: debe ser HTTPS, `image/png` o `image/jpeg` (se verifica el content-type y la firma de bytes) y pesar como máximo 500 KB. Los hosts que resuelven a IPs privadas se rechazan y las redirecciones se validan.
- **Secretos**: el token de Jira, SMTP, etc. van en variables de entorno del despliegue, nunca en el repo (ver `.env.example`). `/api/dispatch` sin `CRON_SECRET` queda cerrado.

## Puesta en marcha

1. Crear el proyecto en Vercel apuntando a este repo y una base en Neon.
2. Cargar en Vercel las variables obligatorias de `.env.example`:
   - `DATABASE_URL`
   - `JIRA_EMAIL` y `JIRA_API_TOKEN`: cuenta de servicio con acceso a JSM.
   - `JANIS_CLIENT_ID`, `JANIS_CLIENT_SECRET`, `JANIS_REDIRECT_URI` y `SESSION_SECRET` (ver [Ingreso con Janis ID](#ingreso-con-janis-id)).
3. Listo para crear suscripciones y usar la vista previa. **Sin SMTP no se envía ningún correo** (ni programado ni de prueba) y la UI lo avisa.
4. Para activar los envíos, más adelante:
   - Cargar `SMTP_*`, `MAIL_FROM` y `CRON_SECRET` en Vercel.
   - Cargar los secrets `DISPATCH_URL` (`https://<deploy>/api/dispatch`) y `CRON_SECRET` en GitHub, para el workflow horario.
5. Tests: `npm install && npm test`.

## Ingreso con Janis ID

OpenID Connect con authorization code flow contra Janis ID (app **Confidential**, `client_secret_post`, más PKCE S256). Datos del discovery (`https://id.janis.in/.well-known/openid-configuration`): issuer `https://id.janis.in`, authorize `https://app.janis.in/oauth/authorize`, token `https://id.janis.in/api/oauth/2.0/token` y JWKS `https://cdn.id.janis.in/.well-known/jwks.json` (RS256).

**Configuración en Janis ID** (admin de la app: `https://app.janis.in/id/app/edit/6ae203fa14168e5d768f015c`):
- La app tiene que estar **Activa**.
- Redirect URIs: `https://caresubscription.vercel.app/login` y, para desarrollo, `http://localhost:3000/login`.
- Scopes: `openid profile email` (más adelante, scopes de servicio como `oms:order:read`, agregándolos a `JANIS_SCOPE`).

**Variables de entorno** (Vercel → Settings → Environment Variables; en local, `.env.local`):

| Variable | Valor |
|---|---|
| `JANIS_CLIENT_ID` | Client ID de la app en Janis ID |
| `JANIS_CLIENT_SECRET` | Client secret (solo en variables de entorno; nunca en el código, commits ni logs) |
| `JANIS_REDIRECT_URI` | `https://caresubscription.vercel.app/login` (local: `http://localhost:3000/login`) |
| `JANIS_SCOPE` | `openid profile email` |
| `SESSION_SECRET` | 32 bytes en base64: `openssl rand -base64 32`. Rotarla cierra todas las sesiones |
| `USER_DOMAIN` | `janiscommerce.com` (dominio de las cuentas que pueden entrar) |

**Rutas** (rewrites de `vercel.json` hacia `api/auth.js`):
- `/login`: es el Redirect URI.
  - Sin `?code`, muestra "Ingresar con Janis". El botón genera `state`, `nonce` y el verificador PKCE, los guarda en una cookie cifrada de 10 minutos y redirige al authorize.
  - Con `?code`, es el callback: valida el `state` (alterado o vencido → rechazo), canjea el code y valida el `id_token` con la JWKS (firma RS256, issuer, audience = client ID, vencimiento y nonce). Después crea la sesión y vuelve al `returnTo` original (solo rutas relativas).
  - Con `?error`, muestra un mensaje y "Reintentar".
- `/logout`: borra la sesión y vuelve a `/login`.
- `/api/me`: `{ sub, email, name }`.
- Sin sesión, la UI y la landing de los envíos redirigen a `/login?returnTo=<ruta>`, y las APIs responden 401.

**Sesión:** cookie HttpOnly, Secure y SameSite=Lax, cifrada con AES-256-GCM (clave derivada de `SESSION_SECRET`). Si hace falta, se parte en `cs_session.0`, `.1`… por el límite de ~4 KB. Guarda `sub`, `email`, `name`, `accessToken`, `refreshToken` y `expiresAt`. Los tokens nunca llegan al navegador ni a las respuestas de la API. Si el access token venció y hay refresh token, se renueva del lado del servidor; si falla (o no hay refresh token), se cierra la sesión. La sesión dura como máximo 12 h.

**Helpers de servidor:** `getSession(req, res)` (`lib/auth.js`) devuelve la sesión con los tokens, renovándolos si hace falta. `janisFetch(session, url, options)` (`lib/janis-id.js`) llama APIs de Janis con el access token del usuario, para cuando se agreguen scopes de servicio.

**Por qué `node:crypto` y no `jose`:** las versiones actuales de `jose` son solo ESM y no cargan con `require()` en el runtime de Vercel; eso ya provocó un error 500 en producción (`ERR_REQUIRE_ESM`). La verificación RS256 con JWK y el cifrado AES-GCM salen de `node:crypto`, sin dependencias nuevas.

**Logs:** solo se registra qué paso del ingreso falló (por ejemplo, "state inválido" o "token endpoint respondió 400 (invalid_grant)"). Nunca se loguean tokens, secretos, correos ni nombres.

## Varias Organizations por suscripción

Una suscripción puede abarcar más de una Organization, cada una con su logo. En el formulario, **+ Agregar Organization** suma una línea.

- **JQL:** se usa tal cual. Comodines opcionales:
  - `{organization}` es la primera Organization;
  - `{organizations}` es la lista de todas, para usar con `IN`: `Organizations in {organizations}` → `("A", "B")`.
- **Reporte:** un logo por Organization a la izquierda del título. En el envío agrupado, la fila del resumen y la sección muestran todos los logos; en el resumen, los nombres van unidos con " · ".
- **Destinatarios:** se aceptan los dominios permitidos de cualquiera de las Organizations.
- **Datos:** columna `subscriptions.organizations` (JSONB `[{ id, name, logoUrl }]`). La primera Organization también queda en `organization_id`, `organization_name` y `config.logoUrl`, para compatibilidad. Las suscripciones anteriores se leen como una sola Organization.

## Suscripciones y envíos

- **Suscripción = qué se reporta:** título, Organizations con sus logos, JQL y dominios permitidos de cada Organization. Tiene vista previa, historial y preaviso de Slack, pero **no se envía sola**.
- **Envío agrupado = cuándo y a quién:** destinatarios, frecuencia, asunto, idioma, "Activo" y "No enviar si no hay tickets". Incluye **1 o N suscripciones**:
  - **1 suscripción:** sale el reporte individual (formato del boceto aprobado). Acepta destinatarios del cliente: `janiscommerce.com` más los dominios permitidos de sus Organizations.
  - **2 o más:** sale el formato agrupado (spec §10) y **solo destinatarios internos**.
- **Migración automática (una sola vez):**
  - Cada suscripción que tenía destinatarios pasó a un envío de 1 suscripción con su misma configuración, incluido el último horario enviado, así no se repiten ni se pierden envíos. Esos envíos figuran como modificados por "migración automática".
  - La marca `subscriptions.migrated_to_group` evita recrear un envío que se borre después.
  - El índice único `group_sends.legacy_subscription_id` evita duplicados.

## Envío agrupado (spec §10)

Un solo correo con la información de varias suscripciones, una sección por Organization. Formato **v2** (`caresubscribe-correo-agrupado-v2.md`, reemplaza §10.2): replica la maqueta `care-weekly-status-opcion-b-graficos.html`. Solo los últimos 3 meses, sin métricas semanales.

- **Modelo:** la entidad `group_sends` tiene título, destinatarios, frecuencia, idioma, "no enviar si está vacío" y suscripciones incluidas. Cada suscripción conserva su título, sus logos, su JQL y sus Organizations.
- **Solo destinatarios internos (con 2 o más suscripciones):** se aceptan solo direcciones de `INTERNAL_DOMAIN` (por defecto `janiscommerce.com`), sin importar los dominios permitidos de cada cliente. Se valida al guardar, al enviar y en las pruebas.
- **Correo (v2):** tablas, estilos inline, ancho máx. 680 px, `Montserrat, Arial, Helvetica, sans-serif`, sin `<style>`, JS ni SVG. En este orden:
  - header con el isotipo, el título, "Tickets creados en los últimos 3 meses · Corte: <fecha>" y **"Ver en la web ↗"**;
  - **tabla resumen**: una fila por suscripción con logo, nombre (enlace a `#org-<slug>`) y **barra apilada** por estado (celdas con `bgcolor`, sin imágenes), y las columnas Total / Resueltos / **Abiertos**; fila Total con las sumas. Si una Organization falla, su fila muestra "—". Debajo, la leyenda de colores de todos los estados;
  - por cada suscripción: separador, logo + nombre visible (el título sin el prefijo común, por ejemplo "Care Weekly Status — Carrefour Argentina · PMC Gold" → "Carrefour Argentina · PMC Gold"), **dona chica** en PNG (192 px mostrada a 96) con el total al centro, la línea `67 tickets · 58 resueltos (87 %) · 9 abiertos` (`· N cancelados` solo si hay), la leyenda con cantidades > 0, la tarjeta **Tickets Abiertos** (clave, resumen y pill del estado) y "↑ Volver arriba";
  - footer con el logo completo de Janis Commerce.

  El orden es alfabético por Organization. Resueltos = estado `resolved`; abiertos = estados con `open: true`; la dona y la barra siguen `chartOrder` de `config/statuses.json` (Resuelto, Revisión, Esperando Información, En Desarrollo, En Progreso, Por Hacer, Cancelada). Cancelada (`hideWhenZero`) solo se muestra si tiene tickets. Pills y puntos usan `background-color` inline (Gmail descarta otros fondos). Las marcas de Janis van por URL pública (`/brand/*.png`) cuando se conoce la URL de la app; los logos y las donas van por CID con `Content-Disposition: inline`, así Gmail no los muestra como adjuntos. Nunca base64 en el HTML; si supera ~100 KB, se avisa en el historial.
- **Landing:** `/reportes/<id>/<fecha>` (`?h=<historyId>` para un envío puntual) muestra la copia guardada en el historial. Requiere sesión: sin sesión, pide la clave y vuelve a la landing. La URL base sale de `APP_URL` o, si no está, de `VERCEL_PROJECT_PRODUCTION_URL`.
- **Si falla una Organization:** el correo sale igual y su sección dice "No se pudo obtener la información". Si fallan todas, no se envía y se reintenta en la corrida siguiente.
- **Historial:** un registro por envío (`send_history.group_id`), con el detalle por Organization. El dispatcher horario despacha suscripciones y envíos agrupados.

## Preaviso en Slack

Cada suscripción tiene el botón **💬 Avisar en #canal**. Publica en Slack un mensaje con el próximo envío a Consulting y los **tickets abiertos agrupados por Responsable** (asignado en Jira; "Sin asignar" al final), con link a Jira. Sirve para que Customer Care se ponga al día antes del envío a Consulting. El correo no muestra el responsable (spec §5.1): solo el preaviso.

- **Historial:** queda registrado como "Preaviso Slack", con su vista. No cuenta como último envío de correo.
- **Configuración:**
  - `SLACK_BOT_TOKEN`: bot con `chat:write`, invitado al canal.
  - `SLACK_CHANNEL`: nombre o ID del canal. Por defecto `#care-test`.
  - Para pasar a `#care-talks`, cambiar `SLACK_CHANNEL` y hacer Redeploy.
- **Mensajes largos:** si el mensaje supera unos 3.800 caracteres, se cortan los últimos grupos y se indica cuántos tickets quedaron afuera.

## Home, Clientes PMC e Impacto Care

`/` es el **Home** con tres accesos:
- **Suscripciones y envíos** (`/suscripciones`): lo que ya existía.
- **Clientes PMC** (`/clientes-pmc`): configuración.
- **Impacto Care** (`/impacto`): el dashboard.

Audiencia interna (Consulting, Producto y Dirección), siempre con login de Janis.

### Clientes PMC
- **Clientes:** Organization de Jira, nivel, fecha de alta en PMC, logo y si está activo. "Buscar sugerencias en Jira" lista las Organizations con tickets marcados *Cuenta Janis: PMC* en los últimos 90 días que todavía no están cargadas.
- **Niveles:** nombre y metas de SLA de contrato (primera respuesta y resolución, en horas corridas). Cada nivel define las metas de sus clientes.
- **Cómo se calcula:**
  - agentes de Care (por defecto Guardia, Joel, Mauricio y Erwin);
  - proyectos de escalamiento (por defecto `HDI`);
  - zona horaria para cortar las semanas (por defecto Buenos Aires).
  Si cambian los agentes o el escalamiento, hay que usar **Recalcular todo**.
- **Datos de Jira:** estado de la sincronización, **Sincronizar ahora** y **Recalcular todo**.

### Datos y sincronización
`lib/impact/sync.js` lee el proyecto JCS y guarda en `ticket_facts` **solo métricas por ticket**:
- fechas de creación, resolución y primera respuesta;
- Organizations;
- SLA "Time to resolution" de Jira;
- si se escaló.

Nunca guarda resumen, descripción, comentarios ni personas. Los comentarios se leen en memoria para ubicar la primera respuesta y se descartan.
- **Carga inicial:** 2 años, en partes de ~40 s (límite de 60 s de Vercel), con un cursor por fecha de creación. El botón "Sincronizar ahora" repite partes hasta terminar.
- **Incremental:** los tickets actualizados desde la última corrida. Lo dispara el workflow horario (`.github/workflows/dispatch.yml`, mismo `CRON_SECRET`) o el botón.
- Hay un lock para que no corran dos sincronizaciones a la vez.

### Definiciones (todo por equipo, nunca por persona)
- **Semana:** de lunes a domingo, en la zona horaria configurada. La semana en curso no se grafica.
- **Primera respuesta real:** el primer comentario **público** de un agente de Care (según la lista configurada; nunca cuentas de clientes) **después del primer comentario**, que es la respuesta automática "en breve un Agente tomará este caso…". Se ignoran las notas internas y los comentarios del cliente. El SLA "Time to first response" de Jira no se usa porque lo detiene esa respuesta automática.
- **SLA A (Jira):** % de resueltos sin incumplir "Time to resolution".
- **SLA B (contrato):** % dentro de las metas del nivel PMC del cliente, en horas corridas. En primera respuesta, un ticket sin respuesta que ya pasó la meta cuenta como fuera de SLA.
- **Resuelto sin escalar:** % de resueltos sin enlace a un ticket de los proyectos de escalamiento (HDI).
- **Backlog:** tickets abiertos al cierre de cada semana; también se muestran los abiertos hace más de 30 días.
- **Cancelados:** no cuentan como resueltos.
- **Indicadores:** las últimas 4 semanas completas comparadas con las 4 anteriores.
- **Antes y después de PMC:** las 12 semanas previas al alta contra las últimas 12 semanas.
- **Logros de Care:** reglas automáticas:
  - el backlog bajó al menos 10 % en 4 semanas;
  - semana récord de resueltos;
  - SLA de al menos 95 %;
  - al menos 80 % resuelto sin escalar;
  - primera respuesta al menos 20 % más rápida;
  - clientes sin tickets abiertos de más de 30 días.

## Cómo sumar un módulo nuevo

1. Crear `modules/<id>/index.js` que exporte `id`, `name`, `defaultConfig()`, `validateConfig(input, { organization, checkRemote })` y `build(subscription, { now, mode })`. `build` devuelve `{ subject, html, text, attachments, itemCount, empty, skipIfEmpty, warnings }`.
2. Registrarlo en `modules/index.js`.
3. Agregar sus campos propios al formulario de `public/index.html`. Se guardan en `subscriptions.config`.

La programación, el envío, el historial, la auditoría y los destinatarios funcionan sin cambios.

## Pendientes / por definir (spec §9)

- Remitente definitivo y servicio de correo. Hoy se usa SMTP genérico, compatible con SES, y `MAIL_FROM` vale por defecto `care@janiscommerce.com`.
- Si los destinatarios externos sin acceso a Jira deben ver enlaces al portal de cliente o solo la clave. Hoy la clave enlaza a `/browse/<KEY>`.
- Adjuntar el reporte también como HTML/PDF (opcional en la spec, no implementado).
