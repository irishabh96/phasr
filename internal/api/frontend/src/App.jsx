import layoutHtml from "./layout.html?raw";

export default function App() {
  return <div dangerouslySetInnerHTML={{ __html: layoutHtml }} />;
}
