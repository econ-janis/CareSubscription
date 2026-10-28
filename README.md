# CareSubscription

Notificaciones programadas de información de clientes de Janis Commerce a las áreas que corresponda.
El repo está organizado en **módulos** (apartados); cada uno tiene su configuración, plantilla y programación, y reutiliza la parte común: integración con Jira, envío de correo, programación, historial, auditoría y control de destinatarios.

| Módulo | Estado | Descripción |
|---|---|---|
| `ticket-report` | ✅ | Reporte por correo del estado de los tickets de JSM de una Organization (últimos 3 meses): dona por estado, detalle por estado y tickets abiertos. |

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

Cada suscripción define días de la semana, hora y zona horaria (por defecto `America/Santiago`). El dispatcher corre cada hora (`.github/workflows/dispatch.yml`, porque el plan Hobby de Vercel solo permite crons diarios). En cada corrida:

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

- **Acceso**: la UI y la API requieren una clave compartida (`ACCESS_KEY`) y que el usuario declare su correo de `USER_DOMAIN`, que se usa para la auditoría y para "Enviar prueba". El servidor emite una cookie de sesión HttpOnly, Secure y SameSite=Lax, firmada y válida por 12 h. Rotar la clave cierra todas las sesiones. Sin `ACCESS_KEY` no se puede entrar: la app muestra tickets y destinatarios de clientes, así que nunca queda pública.
  - Limitación: el correo declarado no se verifica. Para tener identidad verificada, el siguiente paso es SSO con Google Workspace.
- **Destinatarios**: deben tener formato válido y un dominio de la lista permitida, que es `ALLOWED_RECIPIENT_DOMAINS` más los dominios del cliente cargados para esa Organization desde la UI. Se validan al guardar y otra vez en cada envío.
- **Enviar prueba**: se envía solo a quien está configurando.
- **Auditoría**: se registra quién creó, modificó o borró cada suscripción (y los dominios de cada Organization), cuándo y qué campos cambió.
- **Datos**: no se guarda contenido de tickets. El historial registra solo fecha, cantidad de tickets, destinatarios, resultado y error.
- **Logo URL**: debe ser HTTPS, `image/png` o `image/jpeg` (se verifica el content-type y la firma de bytes) y pesar como máximo 500 KB. Los hosts que resuelven a IPs privadas se rechazan y las redirecciones se validan.
- **Secretos**: el token de Jira, SMTP, etc. van en variables de entorno del despliegue, nunca en el repo (ver `.env.example`). `/api/dispatch` sin `CRON_SECRET` queda cerrado.

## Puesta en marcha

1. Crear el proyecto en Vercel apuntando a este repo y una base en Neon.
2. Cargar en Vercel las variables obligatorias de `.env.example`:
   - `DATABASE_URL`
   - `JIRA_EMAIL` y `JIRA_API_TOKEN`: cuenta de servicio con acceso a JSM.
   - `ACCESS_KEY`: mínimo 16 caracteres aleatorios. Se comparte por un canal seguro con quienes usan la app.
3. Listo para crear suscripciones y usar la vista previa. **Sin SMTP no se envía ningún correo** (ni programado ni de prueba) y la UI lo avisa.
4. Para activar los envíos, más adelante:
   - Cargar `SMTP_*`, `MAIL_FROM` y `CRON_SECRET` en Vercel.
   - Cargar los secrets `DISPATCH_URL` (`https://<deploy>/api/dispatch`) y `CRON_SECRET` en GitHub, para el workflow horario.
5. Tests: `npm install && npm test`.

## Cómo sumar un módulo nuevo

1. Crear `modules/<id>/index.js` que exporte `id`, `name`, `defaultConfig()`, `validateConfig(input, { organization, checkRemote })` y `build(subscription, { now, mode })`. `build` devuelve `{ subject, html, text, attachments, itemCount, empty, skipIfEmpty, warnings }`.
2. Registrarlo en `modules/index.js`.
3. Agregar sus campos propios al formulario de `public/index.html`. Se guardan en `subscriptions.config`.

La programación, el envío, el historial, la auditoría y los destinatarios funcionan sin cambios.

## Pendientes / por definir (spec §9)

- Remitente definitivo y servicio de correo. Hoy se usa SMTP genérico, compatible con SES, y `MAIL_FROM` vale por defecto `care@janiscommerce.com`.
- Si los destinatarios externos sin acceso a Jira deben ver enlaces al portal de cliente o solo la clave. Hoy la clave enlaza a `/browse/<KEY>`.
- Adjuntar el reporte también como HTML/PDF (opcional en la spec, no implementado).
